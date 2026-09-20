import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  clientAddress,
  forget,
  hit,
  retryAfterPhrase,
  type RateLimitRule,
} from "@/lib/rate-limit";
import { prisma } from "@/lib/db";

/**
 * The abuse limits on sign-in, sign-up and the pay redirect.
 *
 * Counted in the database rather than in memory, so these run against the
 * throwaway one: what is under test is the window arithmetic and the counting,
 * both of which live in Prisma calls.
 */

const RULE: RateLimitRule = { limit: 3, windowSeconds: 900 };

let key: string;

beforeEach(() => {
  // A fresh key per test, since rows outlive a single case.
  key = `test:${randomUUID()}`;
});

describe("hit", () => {
  it("allows up to the limit and refuses the one that passes it", async () => {
    expect((await hit(key, RULE)).ok).toBe(true);
    expect((await hit(key, RULE)).ok).toBe(true);
    expect((await hit(key, RULE)).ok).toBe(true);

    // The attempt that trips the limit is the one refused, not the one after.
    expect((await hit(key, RULE)).ok).toBe(false);
  });

  it("counts down what is left", async () => {
    expect((await hit(key, RULE)).remaining).toBe(2);
    expect((await hit(key, RULE)).remaining).toBe(1);
    expect((await hit(key, RULE)).remaining).toBe(0);
  });

  it("says how long to wait, only once it is refusing", async () => {
    const allowed = await hit(key, RULE);
    expect(allowed.retryAfterSeconds).toBe(0);

    await hit(key, RULE);
    await hit(key, RULE);
    const refused = await hit(key, RULE);

    expect(refused.ok).toBe(false);
    expect(refused.retryAfterSeconds).toBeGreaterThan(0);
    expect(refused.retryAfterSeconds).toBeLessThanOrEqual(900);
  });

  it("keeps separate keys separate", async () => {
    const other = `test:${randomUUID()}`;

    await hit(key, RULE);
    await hit(key, RULE);
    await hit(key, RULE);
    expect((await hit(key, RULE)).ok).toBe(false);

    // One address being locked out must not lock out everybody else.
    expect((await hit(other, RULE)).ok).toBe(true);
  });

  it("starts a new window once the old one has closed", async () => {
    await hit(key, RULE);
    await hit(key, RULE);
    await hit(key, RULE);
    expect((await hit(key, RULE)).ok).toBe(false);

    // Wind the stored window back into the past rather than waiting out
    // fifteen real minutes.
    await prisma.rateLimit.update({
      where: { key },
      data: { windowEnd: new Date(Date.now() - 1000) },
    });

    const afterExpiry = await hit(key, RULE);
    expect(afterExpiry.ok).toBe(true);
    expect(afterExpiry.remaining).toBe(2);
  });

  it("keeps refusing for the rest of the window", async () => {
    for (let attempt = 0; attempt < 6; attempt++) await hit(key, RULE);

    // Still shut, and the count has not quietly rolled over.
    expect((await hit(key, RULE)).ok).toBe(false);
  });
});

describe("forget", () => {
  it("clears a key, which is what a correct password does", async () => {
    await hit(key, RULE);
    await hit(key, RULE);
    await hit(key, RULE);
    expect((await hit(key, RULE)).ok).toBe(false);

    await forget(key);

    expect((await hit(key, RULE)).ok).toBe(true);
  });

  it("is quiet about a key that was never counted", async () => {
    await expect(forget(`test:${randomUUID()}`)).resolves.toBeUndefined();
  });
});

describe("retryAfterPhrase", () => {
  it("rounds into words somebody can act on", () => {
    expect(retryAfterPhrase(30)).toBe("in a minute");
    expect(retryAfterPhrase(90)).toBe("in a minute");
    expect(retryAfterPhrase(600)).toBe("in 10 minutes");
    expect(retryAfterPhrase(3600)).toBe("in an hour");
    expect(retryAfterPhrase(7200)).toBe("in 2 hours");
  });
});

describe("clientAddress", () => {
  it("takes the client, not the proxy hop behind it", async () => {
    vi.doMock("next/headers", () => ({
      headers: async () => new Headers({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" }),
    }));
    vi.resetModules();

    const { clientAddress: fresh } = await import("@/lib/rate-limit");
    expect(await fresh()).toBe("203.0.113.7");

    vi.doUnmock("next/headers");
    vi.resetModules();
  });

  it("falls back to one shared bucket when no proxy set a header", async () => {
    vi.doMock("next/headers", () => ({ headers: async () => new Headers() }));
    vi.resetModules();

    const { clientAddress: fresh } = await import("@/lib/rate-limit");

    // A desktop install on an office network. Everyone there shares this, which
    // is why sign-in leans on the email address and sign-up skips the limit
    // entirely on desktop.
    expect(await fresh()).toBe("unknown");

    vi.doUnmock("next/headers");
    vi.resetModules();
  });
});

describe("what the limits are set to", () => {
  it("lets a forgetful person keep trying, and stops a word list", async () => {
    const { LOGIN_PER_EMAIL, SIGNUP_PER_IP } = await import("@/lib/rate-limit");

    // Generous for somebody who cannot remember which password they used.
    expect(LOGIN_PER_EMAIL.limit).toBeGreaterThanOrEqual(5);
    // Nowhere near enough to work through a list.
    expect(LOGIN_PER_EMAIL.limit).toBeLessThanOrEqual(20);

    // A real person signs up once.
    expect(SIGNUP_PER_IP.limit).toBeLessThanOrEqual(10);
  });
});

describe("clientAddress in this process", () => {
  it("answers without a request, so a background caller cannot crash", async () => {
    // next/headers throws outside a request scope in some runtimes. The
    // limiter must not be the thing that breaks a cron-style caller.
    await expect(clientAddress()).resolves.toBeTypeOf("string");
  });
});
