import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db";
import { hashPassword, verifyPassword } from "@/lib/password";

/**
 * The launcher's account recovery tool.
 *
 * It carries its own copy of the scrypt code, because it runs under plain Node
 * outside the Next.js build and cannot import the TypeScript module. That
 * duplication is the risk worth testing: if the two ever drift, the recovery
 * tool writes a hash the login screen rejects, and the one thing meant to cure
 * a lockout causes one instead.
 *
 * So these run the real script as a subprocess and verify the result with the
 * application's own verifyPassword.
 */

const SCRIPT = path.resolve(process.cwd(), "electron", "reset-password.js");

function run(...args: string[]) {
  const databaseUrl = process.env.DATABASE_URL ?? "file:./test.db";
  const databaseFile = path.resolve(
    process.cwd(),
    databaseUrl.replace(/^file:/, ""),
  );

  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, databaseFile, ...args], {
      encoding: "utf8",
    });
    return JSON.parse(stdout.trim().split("\n").pop() ?? "{}");
  } catch (error) {
    // The script exits non-zero on a refusal, and still prints its JSON.
    const stdout = (error as { stdout?: string }).stdout ?? "";
    return JSON.parse(stdout.trim().split("\n").pop() ?? "{}");
  }
}

let organizationId: string;
let email: string;
let userId: string;

beforeEach(async () => {
  const org = await prisma.organization.create({
    data: { slug: `recovery-${randomUUID()}`, name: "Recovery Test Co" },
  });
  organizationId = org.id;
  email = `owner-${randomUUID()}@recovery.test`;

  const user = await prisma.user.create({
    data: {
      organizationId,
      email,
      name: "Locked Out Owner",
      role: "OWNER",
      passwordHash: await hashPassword("original1234"),
    },
  });
  userId = user.id;
});

afterEach(async () => {
  await prisma.organization.deleteMany({ where: { id: organizationId } });
});

describe("account recovery", () => {
  it("writes a hash the application accepts", async () => {
    const result = run("reset", email, "recovered2026");
    expect(result.ok).toBe(true);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });

    // The assertion that matters: the app's own verifier, not a reimplementation.
    expect(await verifyPassword("recovered2026", user.passwordHash)).toBe(true);
    expect(await verifyPassword("original1234", user.passwordHash)).toBe(false);
  });

  it("uses the same stored format as the application", async () => {
    run("reset", email, "recovered2026");

    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const mine = await hashPassword("recovered2026");

    // scrypt$N$r$p$… — the parameters must match, or an old hash and a new one
    // cannot both be verified by the same code.
    expect(user.passwordHash.split("$").slice(0, 4)).toEqual(
      mine.split("$").slice(0, 4),
    );
  });

  it("signs the account out everywhere", async () => {
    await prisma.session.createMany({
      data: [
        {
          userId,
          token: `hash-${randomUUID()}`,
          expiresAt: new Date(Date.now() + 86_400_000),
        },
        {
          userId,
          token: `hash-${randomUUID()}`,
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      ],
    });

    const result = run("reset", email, "recovered2026");

    expect(result.sessionsCleared).toBe(2);
    expect(await prisma.session.count({ where: { userId } })).toBe(0);
  });

  it("does not touch anyone else's sessions", async () => {
    const other = await prisma.user.create({
      data: {
        organizationId,
        email: `other-${randomUUID()}@recovery.test`,
        name: "Someone Else",
        role: "ADMIN",
        passwordHash: await hashPassword("original1234"),
      },
    });
    await prisma.session.create({
      data: {
        userId: other.id,
        token: `hash-${randomUUID()}`,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });

    run("reset", email, "recovered2026");

    expect(await prisma.session.count({ where: { userId: other.id } })).toBe(1);
    const untouched = await prisma.user.findUniqueOrThrow({
      where: { id: other.id },
    });
    expect(await verifyPassword("original1234", untouched.passwordHash)).toBe(true);
  });

  it("enforces the same password rules as the application", () => {
    expect(run("reset", email, "short").error).toMatch(/at least 8 characters/i);
    expect(run("reset", email, "alllettershere").error).toMatch(
      /letter and one number/i,
    );
  });

  it("leaves the password alone when it refuses", async () => {
    run("reset", email, "short");

    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(await verifyPassword("original1234", user.passwordHash)).toBe(true);
  });

  it("matches the email regardless of how it was typed", async () => {
    const result = run("reset", email.toUpperCase(), "recovered2026");

    expect(result.ok).toBe(true);
    // Reported back in its stored form, so the confirmation is not misleading.
    expect(result.email).toBe(email);
  });

  it("refuses an account that does not exist", () => {
    const result = run("reset", "nobody@nowhere.test", "recovered2026");

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no account/i);
  });

  it("lists accounts with the organization they belong to", () => {
    const result = run("list");

    expect(result.ok).toBe(true);
    const mine = (result.accounts as { email: string; organization: string; role: string }[]).find(
      (account) => account.email === email,
    );

    // The window shows these, and two people called Lane in two organizations
    // is exactly the case where the wrong one gets picked.
    expect(mine).toMatchObject({
      organization: "Recovery Test Co",
      role: "OWNER",
    });
  });
});
