import { randomUUID } from "node:crypto";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * "Forgot password?", end to end.
 *
 * Through the real actions, pages, session store and database; the request
 * and the mail provider are stood in for. The mail stand-in records what
 * would have been sent, so the tests can follow the link in it exactly as a
 * person would.
 */

const request = vi.hoisted(() => ({
  cookies: new Map<string, string>(),
  headers: {} as Record<string, string>,
}));

const outbox = vi.hoisted(() => ({
  sent: [] as { to: string; subject: string; text: string }[],
  fail: false,
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      request.cookies.has(name) ? { name, value: request.cookies.get(name)! } : undefined,
    set: (name: string, value: string) => {
      request.cookies.set(name, value);
    },
    delete: (name: string) => {
      request.cookies.delete(name);
    },
  }),
  headers: async () => new Headers(request.headers),
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

vi.mock("@/lib/email/providers", async (original) => ({
  ...(await original<typeof import("@/lib/email/providers")>()),
  deliverEmail: vi.fn(async (_provider: unknown, _config: unknown, _secret: unknown, email: { to: string; subject: string; text: string }) => {
    if (outbox.fail) return { ok: false, error: "The mail provider refused the message." };
    outbox.sent.push({ to: email.to, subject: email.subject, text: email.text });
    return { ok: true };
  }),
}));

import { NextRequest } from "next/server";

import {
  loginAction,
  requestPasswordResetAction,
  resetPasswordAction,
} from "@/app/(auth)/actions";
import ForgotPasswordPage from "@/app/(auth)/forgot-password/page";
import { LoginForm } from "@/app/(auth)/login/login-form";
import ResetPasswordPage from "@/app/(auth)/reset-password/[token]/page";
import { getContext } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { hashPassword, verifyPassword } from "@/lib/password";
import {
  RESET_LINK_MINUTES,
  requestReset,
  resetEmail,
  resetToken,
  userForResetToken,
} from "@/lib/password-reset";
import { createSession, SESSION_COOKIE } from "@/lib/session";
import { middleware } from "@/middleware";

const OLD_PASSWORD = "Harbor-Glass-2026";
const NEW_PASSWORD = "Brand-new-pass-77";
const MINUTE_MS = 60 * 1000;

async function person(fields: { email?: string; isActive?: boolean; business?: string } = {}) {
  const org = await prisma.organization.create({
    data: { slug: `reset-${randomUUID()}`, name: fields.business ?? "Harbor Glass Co", billingExempt: true },
  });
  return prisma.user.create({
    data: {
      organizationId: org.id,
      email: fields.email ?? `owner-${randomUUID()}@example.test`,
      name: "Priya Nandakumar",
      passwordHash: await hashPassword(OLD_PASSWORD),
      role: "OWNER",
      isActive: fields.isActive ?? true,
    },
  });
}

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
};

/** The token in the last email sent, read out of its link as a person would. */
function linkedToken() {
  const text = outbox.sent.at(-1)?.text ?? "";
  const match = /https:\/\/www\.matlockone\.com\/reset-password\/(\S+)/.exec(text);
  return match?.[1] ?? null;
}

async function redirectOf(promise: Promise<unknown>) {
  try {
    await promise;
    return null;
  } catch (error) {
    const match = /^NEXT_REDIRECT (.+)$/.exec((error as Error).message);
    if (!match) throw error;
    return match[1];
  }
}

beforeEach(() => {
  vi.stubEnv("SESSION_SECRET", "s".repeat(32));
  vi.stubEnv("APP_URL", "https://www.matlockone.com");
  vi.stubEnv("SYSTEM_MAIL_FROM_EMAIL", "hello@matlockone.com");
  vi.stubEnv("SYSTEM_MAIL_RESEND_API_KEY", "re_test");
  // Hosted, not a desktop install that keeps its own data.
  vi.stubEnv("STORAGE_PROVIDER", "s3");
  outbox.sent = [];
  outbox.fail = false;
  request.cookies.clear();
  request.headers = { "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 250) + 1}` };
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ------------------------------------------------------------------ links ---

describe("a reset link", () => {
  it("opens the account it was made for", async () => {
    const user = await person();

    expect((await userForResetToken(resetToken(user)))?.id).toBe(user.id);
  });

  it(`stops working after ${RESET_LINK_MINUTES} minutes`, async () => {
    const user = await person();
    const made = new Date();
    const token = resetToken(user, made);

    const justBefore = new Date(made.getTime() + (RESET_LINK_MINUTES - 1) * MINUTE_MS);
    const justAfter = new Date(made.getTime() + (RESET_LINK_MINUTES + 1) * MINUTE_MS);
    expect(await userForResetToken(token, justBefore)).not.toBeNull();
    expect(await userForResetToken(token, justAfter)).toBeNull();
  });

  it("cannot be altered to open another account or last longer", async () => {
    const user = await person();
    const other = await person();
    const [id, expires, signature] = resetToken(user).split(".");

    const later = (Number.parseInt(expires, 36) + 86_400).toString(36);
    for (const forged of [
      `${other.id}.${expires}.${signature}`,
      `${id}.${later}.${signature}`,
      `${id}.${expires}.${signature.slice(0, -2)}AA`,
      `${id}.${expires}`,
      "",
      "not-a-token",
    ]) {
      expect(await userForResetToken(forged), forged).toBeNull();
    }
  });

  it("works once: saving a new password retires every link sent before it", async () => {
    const user = await person();
    const token = resetToken(user);

    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await hashPassword(NEW_PASSWORD) },
    });

    expect(await userForResetToken(token)).toBeNull();
  });

  it("opens nothing for someone who has been deactivated", async () => {
    const user = await person({ isActive: false });

    expect(await userForResetToken(resetToken(user))).toBeNull();
  });

  it("cannot be made without the server's secret", async () => {
    const user = await person();
    vi.stubEnv("SESSION_SECRET", "t".repeat(32));
    const madeElsewhere = resetToken(user);
    vi.stubEnv("SESSION_SECRET", "s".repeat(32));

    expect(await userForResetToken(madeElsewhere)).toBeNull();
  });
});

// ------------------------------------------------------------------ email ---

describe("the email", () => {
  it("names the business, carries the link, and says what to do if it wasn't you", () => {
    const email = resetEmail({
      to: "priya@harborglass.test",
      name: "Priya Nandakumar",
      businessName: "Harbor Glass Co",
      link: "https://www.matlockone.com/reset-password/abc",
    });

    expect(email.subject).toBe("Reset your Matlock One password");
    expect(email.text).toContain("Hello Priya Nandakumar,");
    expect(email.text).toContain("Harbor Glass Co");
    expect(email.text).toContain("https://www.matlockone.com/reset-password/abc");
    expect(email.text).toContain(`works once, for the next ${RESET_LINK_MINUTES} minutes`);
    expect(email.text).toContain("If you didn't ask, ignore this email");
  });

  it("goes to every active account on the address, each naming its own business", async () => {
    const shared = `shared-${randomUUID()}@example.test`;
    await person({ email: shared, business: "Reyes Electric" });
    await person({ email: shared, business: "Harbor Glass Co" });
    await person({ email: shared, business: "Gone Ltd", isActive: false });

    expect(await requestReset(shared.toUpperCase())).toEqual({ ok: true, sent: 2 });
    expect(outbox.sent.map((mail) => mail.text.includes("Reyes Electric") || mail.text.includes("Harbor Glass Co"))).toEqual([true, true]);
  });

  it("sends nothing, and says it could not, without a mailbox", async () => {
    const user = await person();

    expect(await requestReset(user.email, { mailer: null })).toEqual({ ok: false, reason: "not-configured" });
    expect(outbox.sent).toEqual([]);
  });

  it("does not come apart when the provider refuses", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    outbox.fail = true;
    const user = await person();

    expect(await requestReset(user.email)).toEqual({ ok: true, sent: 0 });
  });
});

// ------------------------------------------------------------- asking for one ---

describe("asking for a link", () => {
  const ask = (email: string) => requestPasswordResetAction({}, form({ email }));

  it("says the same thing whether or not the address has an account", async () => {
    const user = await person();

    const known = await ask(user.email);
    const unknown = await ask(`nobody-${randomUUID()}@example.test`);

    expect(known).toEqual({ done: true, values: { email: user.email } });
    expect(unknown).toMatchObject({ done: true });
    expect(outbox.sent.map((mail) => mail.to)).toEqual([user.email]);
  });

  it("stops after three emails an hour to one address", async () => {
    const user = await person();

    for (let n = 0; n < 3; n++) await ask(user.email);
    const fourth = await ask(user.email);

    expect(fourth.error).toMatch(/Too many reset emails/);
    expect(outbox.sent).toHaveLength(3);
  });

  it("asks for a real email address", async () => {
    expect((await ask("not an email")).fieldErrors?.email).toBe("Enter a valid email.");
  });

  it("says so plainly when this site has no mailbox yet", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("SYSTEM_MAIL_FROM_EMAIL", "");
    const user = await person();

    expect((await ask(user.email)).error).toMatch(/isn’t set up on this site yet/);
  });
});

// ---------------------------------------------------------- using the link ---

describe("choosing the new password", () => {
  const choose = (token: string, password: string, confirm = password) =>
    resetPasswordAction({}, form({ token, password, confirm }));

  it("saves it, signs out every other device, and signs this one in", async () => {
    const user = await person();
    await createSession(user.id);
    const otherDevice = request.cookies.get(SESSION_COOKIE)!;
    request.cookies.clear();

    await requestPasswordResetAction({}, form({ email: user.email }));
    const token = linkedToken()!;

    expect(await redirectOf(choose(token, NEW_PASSWORD))).toBe("/dashboard");

    const saved = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(await verifyPassword(NEW_PASSWORD, saved.passwordHash)).toBe(true);
    expect(await verifyPassword(OLD_PASSWORD, saved.passwordHash)).toBe(false);

    // This device is in.
    expect((await getContext())?.user.id).toBe(user.id);
    // The other one is not.
    request.cookies.set(SESSION_COOKIE, otherDevice);
    expect(await getContext()).toBeNull();
  });

  it("will not use the same link twice", async () => {
    const user = await person();
    const token = resetToken(user);
    await redirectOf(choose(token, NEW_PASSWORD));

    const again = await choose(token, "Third-password-9");

    expect(again.error).toMatch(/expired or has already been used/);
  });

  it("asks again for a weak or mistyped password, and the link still works after", async () => {
    const user = await person();
    const token = resetToken(user);

    expect((await choose(token, "short")).fieldErrors?.password).toMatch(/at least 8/);
    expect((await choose(token, NEW_PASSWORD, "Brand-new-pass-78")).fieldErrors?.confirm).toMatch(/don’t match/);
    expect(await redirectOf(choose(token, NEW_PASSWORD))).toBe("/dashboard");
  });

  it("lets somebody who locked themselves out sign in straight away afterwards", async () => {
    const user = await person();
    for (let n = 0; n < 10; n++) await loginAction({}, form({ email: user.email, password: "wrong-guess-1" }));
    expect((await loginAction({}, form({ email: user.email, password: OLD_PASSWORD }))).error).toMatch(/Too many/);

    await redirectOf(choose(resetToken(user), NEW_PASSWORD));
    request.cookies.clear();

    expect(await redirectOf(loginAction({}, form({ email: user.email, password: NEW_PASSWORD })))).toBe("/dashboard");
  });
});

// ----------------------------------------------------------------- screens ---

describe("the screens", () => {
  it("puts 'Forgot password?' on the sign-in form", () => {
    const html = renderToStaticMarkup(createElement(LoginForm, {}));

    expect(html).toContain('href="/forgot-password"');
    expect(html).toContain("Forgot password?");
  });

  it("offers the email form where a link can be sent", async () => {
    const html = renderToStaticMarkup(await ForgotPasswordPage());

    expect(html).toContain("Email me a link");
  });

  it("says so where it cannot, instead of taking the address and sending nothing", async () => {
    vi.stubEnv("SYSTEM_MAIL_RESEND_API_KEY", "");
    const html = renderToStaticMarkup(await ForgotPasswordPage());

    expect(html).toContain("isn’t set up on this site yet");
    expect(html).not.toContain("Email me a link");
  });

  it("points a desktop install that keeps its own data at the launcher", async () => {
    vi.stubEnv("STORAGE_PROVIDER", "local");
    const html = renderToStaticMarkup(await ForgotPasswordPage());

    expect(html).toContain("File → Reset a password…");
  });

  it("shows the new-password form for a good link, and says plainly when a link is spent", async () => {
    const user = await person();

    const good = renderToStaticMarkup(
      await ResetPasswordPage({ params: Promise.resolve({ token: resetToken(user) }) }),
    );
    const spent = renderToStaticMarkup(
      await ResetPasswordPage({ params: Promise.resolve({ token: "made.up.token" }) }),
    );

    expect(good).toContain("Choose a new password");
    expect(good).toContain(user.email);
    expect(spent).toContain("This link can’t be used");
    expect(spent).toContain('href="/forgot-password"');
  });

  it("can be reached without being signed in", () => {
    for (const path of ["/forgot-password", "/reset-password/some.token.here"]) {
      const response = middleware(new NextRequest(`https://www.matlockone.com${path}`));
      expect(response.headers.get("location"), path).toBeNull();
    }
  });
});
