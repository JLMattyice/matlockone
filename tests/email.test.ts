import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closedPort, startFakeSmtp, type FakeSmtpServer } from "./support/smtp-server";
import { deliverEmail, hasGlobalIpv6, preferredAddress } from "@/lib/email/providers";
import {
  impliedSecure,
  isEmailProvider,
  presetForHost,
  reconcileSecure,
  SMTP_PRESETS,
} from "@/lib/email/catalog";

const FROM = { fromName: "Matlock Field Services", fromEmail: "office@matlock.test" };

describe("SMTP delivery", () => {
  let smtp: FakeSmtpServer;

  beforeEach(async () => {
    smtp = await startFakeSmtp();
  });

  afterEach(async () => {
    await smtp.close();
  });

  it("delivers a message a real mail server would accept", async () => {
    const result = await deliverEmail(
      "SMTP",
      { ...FROM, host: "127.0.0.1", port: smtp.port, secure: false, username: "office@matlock.test" },
      "app-password-1234",
      {
        to: "harold@example.test",
        toName: "Harold Pemberton",
        subject: "Invoice INV-1042 from Matlock Field Services",
        text: "Invoice INV-1042 for $1,250.50 is ready.",
        replyTo: "office@matlock.test",
      },
    );

    expect(result.ok).toBe(true);

    const [message] = smtp.messages;
    expect(smtp.messages).toHaveLength(1);

    // The envelope is what actually routes the mail; headers are cosmetic.
    expect(message.from).toBe("office@matlock.test");
    expect(message.to).toEqual(["harold@example.test"]);

    expect(message.data).toContain(
      "Subject: Invoice INV-1042 from Matlock Field Services",
    );
    expect(message.data).toContain("Harold Pemberton");
    expect(message.data).toContain("Reply-To: office@matlock.test");
    expect(message.data).toContain("Invoice INV-1042 for $1,250.50 is ready.");
  });

  it("sends the stored credentials, not the from address", async () => {
    await deliverEmail(
      "SMTP",
      { ...FROM, host: "127.0.0.1", port: smtp.port, username: "smtp-user@matlock.test" },
      "app-password-1234",
      { to: "harold@example.test", subject: "Test", text: "Hello." },
    );

    expect(smtp.messages[0].username).toBe("smtp-user@matlock.test");
    expect(smtp.messages[0].password).toBe("app-password-1234");
  });

  it("refuses to try when the server details are incomplete", async () => {
    const result = await deliverEmail(
      "SMTP",
      { ...FROM, port: smtp.port },
      "app-password-1234",
      { to: "harold@example.test", subject: "Test", text: "Hello." },
    );

    expect(result).toEqual({
      ok: false,
      error: "SMTP host and username are required.",
    });
    expect(smtp.messages).toHaveLength(0);
  });
});

describe("SMTP failures", () => {
  it("explains a rejected password instead of quoting the server", async () => {
    const smtp = await startFakeSmtp({ rejectAuth: true });

    const result = await deliverEmail(
      "SMTP",
      { ...FROM, host: "127.0.0.1", port: smtp.port, username: "office@matlock.test" },
      "wrong-password",
      { to: "harold@example.test", subject: "Test", text: "Hello." },
    );

    await smtp.close();

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/app password/i);
  });

  it("reports an unreachable server rather than hanging", async () => {
    // Verified closed at the moment it is handed over. "Almost certainly
    // closed" was not good enough: see closedPort() for what went wrong.
    const deadPort = await closedPort();

    const result = await deliverEmail(
      "SMTP",
      { ...FROM, host: "127.0.0.1", port: deadPort, username: "office@matlock.test" },
      "app-password-1234",
      { to: "harold@example.test", subject: "Test", text: "Hello." },
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(
      /could not reach|firewall/i,
    );
  });
});

describe("provider catalog", () => {
  it("only accepts providers there is an adapter for", () => {
    expect(isEmailProvider("SMTP")).toBe(true);
    expect(isEmailProvider("RESEND")).toBe(true);
    // Rows written by an older or newer build must not be trusted blindly.
    expect(isEmailProvider("STRIPE")).toBe(false);
    expect(isEmailProvider(null)).toBe(false);
  });

  it("pairs implicit TLS with 465 and STARTTLS with 587", () => {
    for (const preset of SMTP_PRESETS) {
      if (preset.id === "custom") continue;
      expect(preset.secure).toBe(preset.port === 465);
    }
  });
});

/**
 * The presets exist so somebody connecting their mailbox does not have to know
 * what a host name is. What actually stops people is the credential: every one
 * of these refused plain account passwords years ago, and each calls the
 * replacement something different.
 */
describe("SMTP presets", () => {
  it("tells you what credential to fetch, for every provider offered", () => {
    for (const preset of SMTP_PRESETS) {
      // "Authentication failed" with no explanation is where people give up.
      expect(preset.credential.length).toBeGreaterThan(40);
    }
  });

  it("pairs implicit TLS with 465 and STARTTLS with 587", () => {
    for (const preset of SMTP_PRESETS) {
      if (!preset.host) continue;
      // A preset that disagreed with itself would hand somebody the exact
      // mismatch this rule exists to prevent.
      expect(preset.secure).toBe(impliedSecure(preset.port));
    }
  });

  it("reopens a saved account on the provider it belongs to", () => {
    expect(presetForHost("smtp.gmail.com")).toBe("gmail");
    expect(presetForHost("smtp.hostinger.com")).toBe("hostinger");
    expect(presetForHost("outbound.att.net")).toBe("att");
    // Case and stray spaces come from people pasting out of a help page.
    expect(presetForHost("  SMTP.Gmail.com  ")).toBe("gmail");
  });

  it("falls back to Other for a host it does not know", () => {
    expect(presetForHost("mail.someones-web-host.net")).toBe("custom");
    // An unconnected account has no host at all, and must not claim to be a
    // provider whose credential advice would then be wrong.
    expect(presetForHost("")).toBe("custom");
  });
});

/**
 * Choosing which address to dial.
 *
 * This exists because of a real failure: "connect ENETUNREACH
 * 2606:4700:90:0:f225:a1af:129b:4ba1:587". The mail server publishes both an
 * IPv4 and an IPv6 address, nodemailer picks one of them at *random* on every
 * send, and the machine had no route to the IPv6 internet — so sending worked
 * or failed by coin toss, with a raw socket error as the only explanation.
 */
describe("picking a reachable address", () => {
  const v4 = { address: "172.65.255.143", family: 4 };
  const v6 = { address: "2606:4700:90:0:f225:a1af:129b:4ba1", family: 6 };

  it("prefers IPv4, which works on every network", () => {
    expect(preferredAddress([v6, v4], true)).toBe(v4.address);
    expect(preferredAddress([v4, v6], false)).toBe(v4.address);
  });

  it("uses IPv6 only when the machine can actually route it", () => {
    expect(preferredAddress([v6], true)).toBe(v6.address);
    // The bug in one line: an IPv6-only answer on an IPv4-only network.
    expect(preferredAddress([v6], false)).toBeNull();
  });

  it("gives up rather than guessing when nothing is usable", () => {
    // Null hands the hostname back to the mail library, whose own resolution is
    // no worse than a guess invented here.
    expect(preferredAddress([], true)).toBeNull();
  });
});

describe("deciding whether IPv6 works here", () => {
  const iface = (address: string, extra: Record<string, unknown> = {}) => ({
    address,
    family: "IPv6",
    internal: false,
    netmask: "",
    mac: "",
    cidr: null,
    scopeid: 0,
    ...extra,
  });

  it("does not count a private address as a route to the internet", () => {
    // Exactly this machine: the router hands out fdb1:… from fc00::/7 and
    // carries no IPv6 traffic at all. Counting interfaces called it capable.
    expect(
      hasGlobalIpv6({ Wifi: [iface("fdb1:4796:672f:0:d49c:828d:75a8:288e")] } as never),
    ).toBe(false);
  });

  it("ignores link-local and loopback addresses", () => {
    expect(hasGlobalIpv6({ Wifi: [iface("fe80::1")] } as never)).toBe(false);
    expect(
      hasGlobalIpv6({ Loopback: [iface("::1", { internal: true })] } as never),
    ).toBe(false);
  });

  it("recognises a real global address", () => {
    expect(hasGlobalIpv6({ Wifi: [iface("2601:1c2:200:abcd::42")] } as never)).toBe(true);
  });

  it("is false on a machine with no IPv6 at all", () => {
    expect(hasGlobalIpv6({} as never)).toBe(false);
  });
});

/**
 * Port and encryption are two halves of one decision.
 *
 * The settings screen used to let them disagree, and a working Hostinger
 * account was saved as port 587 with implicit TLS on. The connection then died
 * with "wrong version number" from OpenSSL — the client had opened with a TLS
 * handshake and the server had replied with a plaintext SMTP greeting.
 */
describe("port and encryption", () => {
  it("wants TLS from the first byte only on 465", () => {
    expect(impliedSecure(465)).toBe(true);
    expect(impliedSecure(587)).toBe(false);
    expect(impliedSecure(25)).toBe(false);
    expect(impliedSecure(2525)).toBe(false);
  });

  it("sends anyway when the port and encryption setting disagree", async () => {
    const smtp = await startFakeSmtp();

    try {
      const result = await deliverEmail(
        "SMTP",
        {
          ...FROM,
          host: "127.0.0.1",
          port: smtp.port,
          // A plaintext server addressed as though it spoke TLS from the first
          // byte — exactly the configuration that was saved here in practice.
          secure: true,
          username: "office@matlock.test",
        },
        "app-password-1234",
        { to: "client@example.test", subject: "Hello", text: "Body" },
      );

      // Nothing has been offered to the server when the handshake fails, so
      // trying it the only other way it could have meant is safe — and far
      // better than handing a business owner an OpenSSL diagnostic.
      expect(result.ok).toBe(true);
      expect(smtp.messages).toHaveLength(1);
    } finally {
      await smtp.close();
    }
  });

  it("does not send twice while recovering", async () => {
    const smtp = await startFakeSmtp();

    try {
      await deliverEmail(
        "SMTP",
        { ...FROM, host: "127.0.0.1", port: smtp.port, secure: true, username: "office@matlock.test" },
        "app-password-1234",
        { to: "client@example.test", subject: "Hello", text: "Body" },
      );

      // The retry exists because the first attempt died mid-handshake. If it
      // ever fired after a message had been accepted, a customer would be
      // invoiced twice.
      expect(smtp.messages).toHaveLength(1);
    } finally {
      await smtp.close();
    }
  });

  it("still reports a wrong password rather than retrying forever", async () => {
    const smtp = await startFakeSmtp({ rejectAuth: true });

    try {
      const result = await deliverEmail(
        "SMTP",
        { ...FROM, host: "127.0.0.1", port: smtp.port, secure: false, username: "office@matlock.test" },
        "the-wrong-one",
        { to: "client@example.test", subject: "Hello", text: "Body" },
      );

      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error).toMatch(/username and password/i);

      // And it must not have tried a second time. The retry is for one exact
      // failure, during the handshake; anything broader would hammer a mail
      // server with a bad password and risk re-sending past the point where a
      // message had already been accepted.
      expect(smtp.connections()).toBe(1);
    } finally {
      await smtp.close();
    }
  });

  it("shows a workable pair when a contradictory one was saved", () => {
    // The settings screen opens on these, so the fix is one Save away rather
    // than something to be spotted and reasoned about.
    expect(reconcileSecure(587, true)).toBe(false);
    expect(reconcileSecure(465, false)).toBe(true);
    expect(reconcileSecure(25, true)).toBe(false);
  });

  it("leaves an unusual port exactly as it was set", () => {
    // A server on 2525 really might want implicit TLS, and this has no
    // business overruling somebody who knows their own mail host.
    expect(reconcileSecure(2525, true)).toBe(true);
    expect(reconcileSecure(2525, false)).toBe(false);
  });
});
