import { randomUUID } from "node:crypto";

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { prisma } from "@/lib/db";
import { hashPassword } from "@/lib/password";

/**
 * The limits as the sign-in and sign-up forms actually apply them.
 *
 * The limiter itself is covered in rate-limit.test.ts. These cover the wiring,
 * which is where the mistakes that matter live: counting the wrong thing,
 * leaking which limit was hit, or locking somebody out of a desktop install
 * they have just downloaded.
 */

const PASSWORD = "correct-horse-7";

/**
 * A successful sign-in creates a session, which is signed. Supplied the way a
 * deployment supplies it, and restored afterwards so a suite sharing this
 * process is unaffected.
 */
const SECRET = "s".repeat(32);
let originalSecret: string | undefined;

beforeAll(() => {
  originalSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = SECRET;
});

afterAll(() => {
  if (originalSecret === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = originalSecret;
});

let address = "203.0.113.9";

// Both actions read the caller's address through next/headers, and the session
// they create on success writes cookies through it too.
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": address }),
  cookies: async () => ({
    get: () => undefined,
    set: () => undefined,
    delete: () => undefined,
  }),
}));

// redirect() throws to unwind the request, which is how a successful sign-in
// ends. Turned into something a test can recognise.
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
}));

const { loginAction, signupAction } = await import("@/app/(auth)/actions");

function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}

async function signIn(email: string, password: string) {
  return loginAction({}, form({ email, password }));
}

let email: string;

beforeEach(async () => {
  address = `203.0.113.${Math.floor(Math.random() * 200) + 1}`;
  email = `limits-${randomUUID()}@example.test`;

  const org = await prisma.organization.create({
    data: { slug: `limits-${randomUUID()}`, name: "Limit Test Co" },
  });

  await prisma.user.create({
    data: {
      organizationId: org.id,
      email,
      name: "Alex Rivera",
      passwordHash: await hashPassword(PASSWORD),
      role: "OWNER",
    },
  });
});

afterEach(async () => {
  await prisma.rateLimit.deleteMany({});
});

describe("signing in", () => {
  it("refuses once the attempts on an address run out", async () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      const result = await signIn(email, "wrong-password");
      expect(result.error).toBe("That email and password combination did not match.");
    }

    const locked = await signIn(email, "wrong-password");
    expect(locked.error).toMatch(/Too many sign-in attempts\. Try again in/);
  });

  it("says the same thing whether or not the account exists", async () => {
    // Which limit was hit, or that one was hit at all sooner for a real
    // address, would answer "does this person have an account here".
    const unknown = `nobody-${randomUUID()}@example.test`;

    for (let attempt = 0; attempt < 11; attempt++) await signIn(unknown, "guess");
    const lockedUnknown = await signIn(unknown, "guess");

    for (let attempt = 0; attempt < 11; attempt++) await signIn(email, "guess");
    const lockedKnown = await signIn(email, "guess");

    expect(lockedUnknown.error).toBe(lockedKnown.error);
  });

  it("holds the password back while locked out", async () => {
    for (let attempt = 0; attempt < 11; attempt++) await signIn(email, "wrong");

    // The right password now, and it still refuses: the count is what is being
    // answered, not the credentials.
    const locked = await signIn(email, PASSWORD);
    expect(locked.error).toMatch(/Too many sign-in attempts/);
  });

  it("forgets the count once somebody signs in correctly", async () => {
    for (let attempt = 0; attempt < 5; attempt++) await signIn(email, "wrong");

    // A good password proves this is not the attacker the count was for.
    await expect(signIn(email, PASSWORD)).rejects.toThrow("REDIRECT:/dashboard");

    const cleared = await prisma.rateLimit.findUnique({
      where: { key: `login:email:${email}` },
    });
    expect(cleared).toBeNull();
  });

  it("does not let one locked-out address lock out another", async () => {
    const neighbour = `limits-${randomUUID()}@example.test`;

    for (let attempt = 0; attempt < 11; attempt++) await signIn(email, "wrong");
    expect((await signIn(email, "wrong")).error).toMatch(/Too many/);

    // Same source address, different account: the per-address limit is set
    // well above this, so an office sharing one connection is unaffected.
    const other = await signIn(neighbour, "wrong");
    expect(other.error).toBe("That email and password combination did not match.");
  });
});

describe("signing up", () => {
  /**
   * The sign-up limit applies only where the data is not on this machine, and
   * dataStaysOnThisMachine() reads that off the real configuration: a SQLite
   * database plus local file storage means a desktop install. The tests run on
   * SQLite, so the hosted half is reached by naming a remote store — the same
   * switch a hosted deployment sets, rather than a stub of the function.
   */
  let originalStorage: string | undefined;

  function pretendHosted() {
    originalStorage = process.env.STORAGE_PROVIDER;
    process.env.STORAGE_PROVIDER = "s3";
  }

  afterEach(() => {
    if (originalStorage === undefined) delete process.env.STORAGE_PROVIDER;
    else process.env.STORAGE_PROVIDER = originalStorage;
    originalStorage = undefined;
  });

  const newWorkspace = (name: string, type = "GENERAL") =>
    signupAction(
      {},
      form({
        businessName: name,
        name: "Alex Rivera",
        email: `bulk-${randomUUID()}@example.test`,
        password: PASSWORD,
        businessType: type,
      }),
    );

  it("lets a desktop install set itself up, limit or no limit", async () => {
    // The first screen of a fresh desktop install is this form. Locking
    // somebody out of the copy they just downloaded would be absurd, and on an
    // office network every machine shares one address bucket anyway.
    for (let n = 0; n < 7; n++) {
      await expect(newWorkspace(`Desk Co ${n}`)).rejects.toThrow(
        "REDIRECT:/dashboard",
      );
    }
  });

  it("stops a run of workspaces from one address", async () => {
    pretendHosted();

    // Five are allowed, and each creates a workspace, so each redirects.
    for (let n = 0; n < 5; n++) {
      await expect(newWorkspace(`Bulk Co ${n}`)).rejects.toThrow(
        "REDIRECT:/dashboard",
      );
    }

    const refused = await newWorkspace("Bulk Co 6");
    expect(refused.error).toMatch(/Too many workspaces have been created from here/);
  });

  it("hands back what was typed when it refuses", async () => {
    // The same rule as every other refusal: a rejected form must not empty
    // itself, or the message explains a field nobody can still see.
    pretendHosted();

    for (let n = 0; n < 5; n++) {
      await expect(newWorkspace("Northlight Studio", "AGENCY")).rejects.toThrow(
        "REDIRECT:/dashboard",
      );
    }

    const refused = await newWorkspace("Northlight Studio", "AGENCY");
    expect(refused.values).toMatchObject({
      businessName: "Northlight Studio",
      name: "Alex Rivera",
      businessType: "AGENCY",
    });
  });
});
