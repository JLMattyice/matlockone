import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  deliverLicense,
  licenseEmail,
  systemMailer,
  undeliveredPurchases,
  type SystemMailer,
} from "@/lib/checkout/deliver";
import { startFakeSmtp } from "./support/smtp-server";
import { fulfilPurchase } from "@/lib/checkout/fulfil";
import { prisma } from "@/lib/db";
import type { DeliveryResult, OutboundEmail } from "@/lib/email/providers";
import type { Purchase } from "@/generated/prisma/client";

/**
 * Getting a paid customer their key.
 *
 * The failure that matters is silent: money taken, licence signed, and nothing
 * ever reaching the buyer. So every outcome has to leave a record, and a retry
 * must never send the same key twice.
 */

const keys = generateKeyPairSync("ed25519");
const privateKey = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const now = new Date("2026-09-07T12:00:00Z");

const MAIL_KEYS = [
  "SYSTEM_MAIL_FROM_EMAIL",
  "SYSTEM_MAIL_FROM_NAME",
  "SYSTEM_MAIL_RESEND_API_KEY",
  "SYSTEM_MAIL_SMTP_HOST",
  "SYSTEM_MAIL_SMTP_PORT",
  "SYSTEM_MAIL_SMTP_SECURE",
  "SYSTEM_MAIL_SMTP_USER",
  "SYSTEM_MAIL_SMTP_PASSWORD",
] as const;

const original = Object.fromEntries(MAIL_KEYS.map((k) => [k, process.env[k]]));

function clearMailEnv() {
  for (const key of MAIL_KEYS) delete process.env[key];
}

afterEach(() => {
  for (const key of MAIL_KEYS) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
});

beforeEach(async () => {
  await prisma.purchase.deleteMany({});
});

let counter = 0;
const ref = () => `deliver-${(counter += 1)}-${Date.now()}`;

async function aPurchase(overrides: Partial<Purchase> = {}): Promise<Purchase> {
  const result = await fulfilPurchase(
    {
      provider: "MANUAL",
      externalId: ref(),
      email: "owner@example.com",
      orgName: "Ridgeline Plumbing",
      plan: "business",
    },
    { privateKey, now },
  );

  if (!result.ok) throw new Error("fixture could not be fulfilled");

  if (Object.keys(overrides).length === 0) return result.purchase;

  return prisma.purchase.update({
    where: { id: result.purchase.id },
    data: overrides,
  });
}

/** What a mail client does to a quoted-printable body before showing it. */
function decodeQuotedPrintable(data: string): string {
  return data
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9A-F]{2})/gi, (_, hex: string) =>
      String.fromCharCode(parseInt(hex, 16)),
    );
}

/** A mailer that records what it was asked to send. */
function fakeMailer(result: DeliveryResult = { ok: true }) {
  const sent: OutboundEmail[] = [];

  const mailer: SystemMailer = {
    provider: "SMTP",
    config: { fromName: "Matlock One", fromEmail: "sales@example.com" },
    secret: "secret",
  };

  const send = async (
    _provider: unknown,
    _config: unknown,
    _secret: string,
    message: OutboundEmail,
  ): Promise<DeliveryResult> => {
    sent.push(message);
    return result;
  };

  return { mailer, send: send as never, sent };
}

describe("the message", () => {
  it("carries the key, unwrapped and on its own line", async () => {
    const purchase = await aPurchase();
    const message = licenseEmail(purchase);

    expect(message.to).toBe("owner@example.com");
    expect(message.subject).toContain("Business");
    // The key must survive copy and paste, so it stands alone.
    expect(message.text.split("\n")).toContain(purchase.licenseKey);
  });

  it("says where to paste it", async () => {
    const message = licenseEmail(await aPurchase());

    expect(message.text).toContain("Settings");
    expect(message.text).toContain("Licence");
  });

  it("promises nothing is lost by activating", async () => {
    // The fear this email has to answer: that entering a key wipes what is
    // already there.
    const message = licenseEmail(await aPurchase());
    expect(message.text).toMatch(/stays exactly where it is/i);
  });

  it("describes seats in the customer's terms", async () => {
    const unlimited = await aPurchase({ seats: null, plan: "pro" });
    expect(licenseEmail(unlimited).text).toContain("unlimited people");

    const single = await aPurchase({ seats: 1, plan: "starter" });
    expect(licenseEmail(single).text).toContain("1 person");
  });
});

describe("sending", () => {
  it("marks the purchase delivered", async () => {
    const purchase = await aPurchase();
    const { mailer, send, sent } = fakeMailer();

    const outcome = await deliverLicense(purchase, { mailer, send, now });

    expect(outcome).toEqual({ ok: true, skipped: false });
    expect(sent).toHaveLength(1);

    const stored = await prisma.purchase.findUnique({ where: { id: purchase.id } });
    expect(stored?.deliveredAt).not.toBeNull();
    expect(stored?.deliveryError).toBeNull();
  });

  it("does not send a second time", async () => {
    // Webhook retries are routine. A customer receiving the same key four
    // times reads as a system out of control.
    const purchase = await aPurchase();
    const first = fakeMailer();
    await deliverLicense(purchase, { ...first, now });

    const reloaded = await prisma.purchase.findUnique({
      where: { id: purchase.id },
    });

    const second = fakeMailer();
    const outcome = await deliverLicense(reloaded!, { ...second, now });

    expect(outcome).toEqual({ ok: true, skipped: true });
    expect(second.sent).toHaveLength(0);
  });

  it("records why a send failed, and stays undelivered", async () => {
    const purchase = await aPurchase();
    const { mailer, send } = fakeMailer({
      ok: false,
      error: "The email server rejected that username and password.",
    });

    const outcome = await deliverLicense(purchase, { mailer, send, now });
    expect(outcome.ok).toBe(false);

    const stored = await prisma.purchase.findUnique({ where: { id: purchase.id } });
    expect(stored?.deliveredAt).toBeNull();
    expect(stored?.deliveryError).toContain("rejected");
  });

  it("survives a mailer that throws instead of returning", async () => {
    const purchase = await aPurchase();
    const send = (async () => {
      throw new Error("socket hang up");
    }) as never;

    const outcome = await deliverLicense(purchase, {
      mailer: fakeMailer().mailer,
      send,
      now,
    });

    expect(outcome).toMatchObject({ ok: false });
    const stored = await prisma.purchase.findUnique({ where: { id: purchase.id } });
    expect(stored?.deliveryError).toContain("socket hang up");
  });

  it("explains itself when no mailbox is configured", async () => {
    const purchase = await aPurchase();
    const outcome = await deliverLicense(purchase, { mailer: null, now });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain("SYSTEM_MAIL_FROM_EMAIL");

    const stored = await prisma.purchase.findUnique({ where: { id: purchase.id } });
    expect(stored?.deliveryError).toContain("SYSTEM_MAIL");
  });

  it("refuses a purchase with no licence on it", async () => {
    const purchase = await aPurchase({ licenseKey: null });
    const { mailer, send, sent } = fakeMailer();

    expect(await deliverLicense(purchase, { mailer, send, now })).toMatchObject({
      ok: false,
    });
    expect(sent).toHaveLength(0);
  });
});

describe("catching up", () => {
  it("lists issued licences that never reached anyone", async () => {
    const delivered = await aPurchase();
    await deliverLicense(delivered, { ...fakeMailer(), now });

    await aPurchase();
    await aPurchase();

    const pending = await undeliveredPurchases();
    expect(pending).toHaveLength(2);
    expect(pending.map((p) => p.id)).not.toContain(delivered.id);
  });
});

describe("against a real mail server", () => {
  it("delivers the key over SMTP, end to end", async () => {
    // No fake send here: the configured mailer, the real SMTP adapter, and a
    // server that speaks the actual protocol. This is the only test that proves
    // a key can leave the building.
    const smtp = await startFakeSmtp();

    clearMailEnv();
    process.env.SYSTEM_MAIL_FROM_EMAIL = "sales@matlock.test";
    process.env.SYSTEM_MAIL_FROM_NAME = "Matlock One";
    process.env.SYSTEM_MAIL_SMTP_HOST = "127.0.0.1";
    process.env.SYSTEM_MAIL_SMTP_PORT = String(smtp.port);
    process.env.SYSTEM_MAIL_SMTP_SECURE = "false";
    process.env.SYSTEM_MAIL_SMTP_PASSWORD = "app-password";

    const purchase = await aPurchase();
    const outcome = await deliverLicense(purchase, { now });

    await smtp.close();

    expect(outcome).toEqual({ ok: true, skipped: false });
    expect(smtp.messages).toHaveLength(1);

    const [message] = smtp.messages;
    expect(message.from).toBe("sales@matlock.test");
    expect(message.to).toEqual(["owner@example.com"]);

    // The key has to arrive intact, which is the entire point — and it does not
    // travel intact. A licence is about 300 characters on one line, and SMTP
    // bodies are quoted-printable, which soft-wraps anything past 76 with "=\r\n".
    // The receiving client removes those on decode, so what the customer copies
    // is one unbroken key; asserting against the raw wire would be asserting
    // the wrong thing.
    expect(decodeQuotedPrintable(message.data)).toContain(purchase.licenseKey);

    const stored = await prisma.purchase.findUnique({ where: { id: purchase.id } });
    expect(stored?.deliveredAt).not.toBeNull();
  });
});

describe("the sending account", () => {
  it("is null until an address is set", () => {
    clearMailEnv();
    expect(systemMailer()).toBeNull();
  });

  it("prefers Resend when a key is present", () => {
    clearMailEnv();
    process.env.SYSTEM_MAIL_FROM_EMAIL = "sales@example.com";
    process.env.SYSTEM_MAIL_RESEND_API_KEY = "re_test";

    expect(systemMailer()).toMatchObject({ provider: "RESEND" });
  });

  it("needs both a host and a password for SMTP", () => {
    clearMailEnv();
    process.env.SYSTEM_MAIL_FROM_EMAIL = "sales@example.com";
    process.env.SYSTEM_MAIL_SMTP_HOST = "smtp.example.com";
    // No password yet: half a configuration is not a configuration.
    expect(systemMailer()).toBeNull();

    process.env.SYSTEM_MAIL_SMTP_PASSWORD = "app-password";
    expect(systemMailer()).toMatchObject({ provider: "SMTP" });
  });

  it("infers implicit TLS from port 465 and STARTTLS from 587", () => {
    clearMailEnv();
    process.env.SYSTEM_MAIL_FROM_EMAIL = "sales@example.com";
    process.env.SYSTEM_MAIL_SMTP_HOST = "smtp.example.com";
    process.env.SYSTEM_MAIL_SMTP_PASSWORD = "app-password";

    process.env.SYSTEM_MAIL_SMTP_PORT = "465";
    expect(systemMailer()?.config.secure).toBe(true);

    process.env.SYSTEM_MAIL_SMTP_PORT = "587";
    expect(systemMailer()?.config.secure).toBe(false);
  });

  it("sends from the address when no username is given", () => {
    clearMailEnv();
    process.env.SYSTEM_MAIL_FROM_EMAIL = "sales@example.com";
    process.env.SYSTEM_MAIL_SMTP_HOST = "smtp.example.com";
    process.env.SYSTEM_MAIL_SMTP_PASSWORD = "app-password";

    expect(systemMailer()?.config.username).toBe("sales@example.com");
  });
});
