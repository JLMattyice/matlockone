import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Staying signed in.
 *
 * Two clocks decide whether somebody has to type their password again — the
 * database row and the cookie — and getting either wrong looks identical from
 * the outside: the app asks you to sign in for no reason you can see. So these
 * run against the real database and a real cookie jar rather than asserting on
 * a mock's arguments.
 */

/** Stands in for the browser's jar. `cookies()` is the only thing mocked. */
type StoredCookie = { value: string } & Record<string, unknown>;
const jar = new Map<string, StoredCookie>();

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, ...jar.get(name)! } : undefined),
    set: (name: string, value: string, options: Record<string, unknown> = {}) => {
      jar.set(name, { value, ...options });
    },
    delete: (name: string) => {
      jar.delete(name);
    },
  }),
}));

process.env.SESSION_SECRET ??= "test-secret-0123456789abcdef";

const { createPrismaClient } = await import("@/lib/db");
const {
  SESSION_COOKIE,
  createSession,
  destroySession,
  renewedExpiry,
  resolveSession,
} = await import("@/lib/session");
const { forgetRememberedEmail, rememberEmail, readRememberedEmail } = await import(
  "@/lib/remembered-email"
);

const prisma = createPrismaClient();

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

let organizationId: string;
let userId: string;

beforeAll(async () => {
  const org = await prisma.organization.create({
    data: { slug: `session-${randomUUID()}`, name: "Session Test Co" },
  });
  organizationId = org.id;

  const user = await prisma.user.create({
    data: {
      organizationId,
      email: `owner-${randomUUID()}@test.local`,
      name: "Session Owner",
      passwordHash: "not-used-here",
      role: "OWNER",
    },
  });
  userId = user.id;
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: organizationId } });
  await prisma.$disconnect();
});

beforeEach(() => {
  jar.clear();
});

/** The cookie the browser was handed, as the browser would hold it. */
function cookie() {
  return jar.get(SESSION_COOKIE);
}

/** The row `createSession` just wrote. */
const latestSession = (owner = userId) =>
  prisma.session.findFirstOrThrow({
    where: { userId: owner },
    orderBy: { createdAt: "desc" },
  });

/** Moves a session's deadline into the past to simulate time passing. */
async function ageSession(id: string, byMs: number) {
  const row = await prisma.session.findUniqueOrThrow({ where: { id } });
  await prisma.session.update({
    where: { id },
    data: { expiresAt: new Date(row.expiresAt.getTime() - byMs) },
  });
}

describe("keeping someone signed in", () => {
  it("gives a remembered session a cookie that outlives the session itself", async () => {
    const { token, expiresAt } = await createSession(userId, { remember: true });

    // The row is the authority and lapses after a month of disuse…
    expect(expiresAt.getTime() - Date.now()).toBeGreaterThan(29 * DAY);
    expect(expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(30 * DAY);

    // …while the cookie is only the carrier, and must not be the thing that
    // expires first. A cookie pinned to the row's own deadline would sign a
    // daily user out on a fixed schedule no matter how often they came back.
    const stored = cookie()!;
    expect(stored.value).toBe(token);
    expect(stored.expires).toBeInstanceOf(Date);
    expect((stored.expires as Date).getTime()).toBeGreaterThan(
      expiresAt.getTime() + 300 * DAY,
    );
  });

  it("keeps the cookie for the length of the window when told not to", async () => {
    const { expiresAt } = await createSession(userId, { remember: false });

    // No expiry at all makes it a session cookie: gone when the app closes.
    // This is the shared office computer.
    expect(cookie()!.expires).toBeUndefined();

    // And the server-side window is short too, so a token copied off that
    // machine is worth little even if it is left running.
    expect(expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(12 * HOUR);
    expect(expiresAt.getTime() - Date.now()).toBeGreaterThan(11 * HOUR);
  });

  it("stays signed in by default", async () => {
    // Signup opens a session without an opinion; a brand new owner should not
    // be signed out when they close the window.
    await createSession(userId);
    expect(cookie()!.expires).toBeInstanceOf(Date);
  });

  it("never puts the usable token in the database", async () => {
    const { token } = await createSession(userId, { remember: true });
    const row = await latestSession();

    // A leaked backup should contain no working credential.
    expect(row.token).not.toBe(token);
    expect(await resolveSession(row.token)).toBeNull();
    expect(await resolveSession(token)).not.toBeNull();
  });

  it("keeps the cookie out of reach of page scripts", async () => {
    await createSession(userId, { remember: true });
    expect(cookie()!.httpOnly).toBe(true);
    expect(cookie()!.sameSite).toBe("lax");
  });
});

describe("sliding renewal", () => {
  it("pushes a remembered session forward as it is used", async () => {
    const { token } = await createSession(userId, { remember: true });
    const before = await latestSession();
    await ageSession(before.id, 3 * DAY);

    const resolved = await resolveSession(token);

    // Somebody who opens the app most weeks should never meet the sign-in
    // screen again — the deadline moves with them.
    const after = await prisma.session.findUniqueOrThrow({ where: { id: before.id } });
    expect(after.expiresAt.getTime() - Date.now()).toBeGreaterThan(29 * DAY);
    expect(resolved!.expiresAt.getTime()).toBe(after.expiresAt.getTime());
  });

  it("leaves a session alone when it was not asked to be remembered", async () => {
    const { token } = await createSession(userId, { remember: false });
    const before = await latestSession();
    await ageSession(before.id, 2 * HOUR);
    const aged = await prisma.session.findUniqueOrThrow({ where: { id: before.id } });

    await resolveSession(token);

    // Otherwise unticking the box would quietly buy a thirty-day session.
    const after = await prisma.session.findUniqueOrThrow({ where: { id: before.id } });
    expect(after.expiresAt.getTime()).toBe(aged.expiresAt.getTime());
  });

  it("does not write to the database on every page view", async () => {
    const { token } = await createSession(userId, { remember: true });
    const before = await latestSession();

    await resolveSession(token);
    await resolveSession(token);

    // A renewal that fired constantly would put a write behind every render of
    // every page, on a database that is a single file on one disk.
    const after = await prisma.session.findUniqueOrThrow({ where: { id: before.id } });
    expect(after.expiresAt.getTime()).toBe(before.expiresAt.getTime());
  });

  it("treats a session from before this feature as remembered", () => {
    // The column is new, so every existing row reads back null. Those sessions
    // were all created under the old fixed thirty-day rule, and reading null as
    // "not remembered" would sign out everybody who is signed in today.
    const legacy = { expiresAt: new Date(Date.now() + 20 * DAY), remembered: null };
    expect(renewedExpiry(legacy)).toBeInstanceOf(Date);
  });

  it("refuses to renew a session that has already lapsed", async () => {
    const { token } = await createSession(userId, { remember: true });
    const row = await latestSession();
    await ageSession(row.id, 31 * DAY);

    expect(await resolveSession(token)).toBeNull();
    // Expiring is not a state to come back from.
    expect(await prisma.session.findUnique({ where: { id: row.id } })).toBeNull();
  });

  it("stops renewing a deactivated employee", async () => {
    const employee = await prisma.user.create({
      data: {
        organizationId,
        email: `left-${randomUUID()}@test.local`,
        name: "Former Employee",
        passwordHash: "not-used-here",
        role: "EMPLOYEE",
      },
    });
    const { token } = await createSession(employee.id, { remember: true });
    await prisma.user.update({ where: { id: employee.id }, data: { isActive: false } });

    // Thirty sliding days is a long time to still be in the system after being
    // let go.
    expect(await resolveSession(token)).toBeNull();
  });
});

describe("signing out", () => {
  it("clears the cookie and the row together", async () => {
    const { token } = await createSession(userId, { remember: true });
    const row = await latestSession();

    await destroySession();

    expect(cookie()).toBeUndefined();
    // Leaving the row would let a copied cookie sign back in.
    expect(await prisma.session.findUnique({ where: { id: row.id } })).toBeNull();
  });
});

describe("the email waiting on the sign-in screen", () => {
  it("comes back the way it was stored", async () => {
    await rememberEmail("  Lane.Matlock@Example.COM  ");
    expect(await readRememberedEmail()).toBe("lane.matlock@example.com");
  });

  it("is not readable by scripts on the page", async () => {
    await rememberEmail("lane@example.com");
    expect(jar.get("fb_last_email")!.httpOnly).toBe(true);
  });

  it("can be forgotten", async () => {
    await rememberEmail("lane@example.com");
    await forgetRememberedEmail();

    // Unticking "keep me signed in" should not leave your address on the
    // sign-in screen of a computer you have just said is not yours.
    expect(await readRememberedEmail()).toBe("");
  });

  it("ignores a value too long to be an address", async () => {
    jar.set("fb_last_email", { value: "x".repeat(5000) });
    expect(await readRememberedEmail()).toBe("");
  });

  it("is empty on a machine nobody has signed in on", async () => {
    expect(await readRememberedEmail()).toBe("");
  });
});
