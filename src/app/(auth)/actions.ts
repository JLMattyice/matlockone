"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";

import { login, logout, safeNextPath } from "@/lib/auth";
import {
  DEFAULT_BUSINESS_TYPE,
  isBusinessType,
  vocabularyColumns,
} from "@/lib/business-types";
import { dataStaysOnThisMachine, signupOpen } from "@/lib/config";
import { prisma } from "@/lib/db";
import { hashPassword, passwordProblem } from "@/lib/password";
import { requestReset, userForResetToken } from "@/lib/password-reset";
import { forgetRememberedEmail, rememberEmail } from "@/lib/remembered-email";
import {
  clientAddress,
  forget,
  hit,
  LOGIN_PER_EMAIL,
  LOGIN_PER_IP,
  RESET_REQUEST_PER_EMAIL,
  RESET_REQUEST_PER_IP,
  retryAfterPhrase,
  SIGNUP_PER_IP,
} from "@/lib/rate-limit";
import { createSession, destroyAllSessionsFor } from "@/lib/session";
import { slugify } from "@/lib/utils";

export type AuthFormState = {
  error?: string;
  fieldErrors?: Record<string, string>;
  /**
   * What was typed, handed back so a rejected submission can put it on screen
   * again.
   *
   * React resets an uncontrolled form as soon as its action returns, so
   * without this a single slip — a password missing a digit — empties all four
   * fields, including the three that were right. On the one screen that asks
   * somebody to set up their business that does not read as a validation
   * error; it reads as a button that threw the page away.
   *
   * Passwords are deliberately absent. They are the one value worth retyping
   * rather than round-tripping back through the page.
   */
  values?: Record<string, string>;
  /** The request went through: the screen changes to what happens next. */
  done?: boolean;
};

/**
 * FormData.get() returns string | File | null. Only the string form is ever a
 * field on these forms, and the rest is not worth echoing back.
 */
function text(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value : "";
}

const loginSchema = z.object({
  // Lowercased here as well as in login(), so the attempt count for
  // "Lane@…" and "lane@…" is one count, not two.
  email: z.string().trim().toLowerCase().min(1, "Email is required.").email("Enter a valid email."),
  password: z.string().min(1, "Password is required."),
  // FormData.get() yields null for an absent field, and Zod's .optional()
  // accepts only undefined — .nullish() covers both.
  next: z.string().nullish(),
  // An unticked checkbox is simply absent from the submission, which is why
  // this reads presence rather than a value.
  remember: z.any().transform((value) => value !== null && value !== undefined),
});

export async function loginAction(
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const values = { email: text(formData.get("email")) };

  const parsed = loginSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
    next: formData.get("next"),
    remember: formData.get("remember"),
  });

  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? "form");
      fieldErrors[key] ??= issue.message;
    }
    // Anything not tied to a visible input would fail silently, so it is
    // promoted to the form-level banner instead.
    const orphan = Object.keys(fieldErrors).find(
      (key) => key !== "email" && key !== "password" && key !== "remember",
    );
    if (orphan) {
      return { error: "Something went wrong. Please try again.", values };
    }
    return { fieldErrors, values };
  }

  const { remember } = parsed.data;
  const email = parsed.data.email;

  // Counted before the password is checked, so being rate limited costs an
  // attacker a request rather than a password hash — and so the answer cannot
  // be timed to tell whether the address exists.
  const address = await clientAddress();
  const [perEmail, perAddress] = await Promise.all([
    hit(`login:email:${email}`, LOGIN_PER_EMAIL),
    hit(`login:ip:${address}`, LOGIN_PER_IP),
  ]);

  if (!perEmail.ok || !perAddress.ok) {
    const wait = Math.max(perEmail.retryAfterSeconds, perAddress.retryAfterSeconds);

    // Deliberately the same message either way: which limit was hit would say
    // whether anybody has been trying this address.
    return {
      error: `Too many sign-in attempts. Try again ${retryAfterPhrase(wait)}.`,
      values,
    };
  }

  const result = await login(email, parsed.data.password, { remember });
  if (!result.ok) return { error: result.error, values };

  // Whoever this is knows the password, so they are not the attacker the count
  // was accumulating against.
  await forget(`login:email:${email}`);

  // Only once the credentials were right, so a mistyped address is not the one
  // waiting on the screen next time.
  if (remember) await rememberEmail(result.user.email);
  else await forgetRememberedEmail();

  // Only a path on this site, so ?next= cannot bounce somebody to a
  // look-alike site the moment they have signed in.
  redirect(safeNextPath(parsed.data.next));
}

export async function logoutAction() {
  await logout();
  redirect("/login");
}

const signupSchema = z.object({
  businessName: z.string().trim().min(2, "Enter your business name."),
  name: z.string().trim().min(2, "Enter your name."),
  email: z.string().trim().toLowerCase().email("Enter a valid email."),
  password: z.string(),
  /**
   * Chooses the starting vocabulary. Never a reason to refuse a signup: an
   * unknown value, or none at all, is the general preset — which is the
   * wording the product shipped with, and all of it editable in Settings.
   */
  businessType: z
    .string()
    .trim()
    .transform((value) => (isBusinessType(value) ? value : DEFAULT_BUSINESS_TYPE)),
});

export async function signupAction(
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  // Read before validation, so a submission that never parses still comes back
  // with what was in the boxes.
  const values = {
    businessName: text(formData.get("businessName")),
    name: text(formData.get("name")),
    email: text(formData.get("email")),
    businessType: text(formData.get("businessType")),
  };

  // The page no longer offers the form when this is shut, but an action is a
  // public endpoint and a stale tab can still post to it.
  if (!signupOpen()) {
    return { error: "New accounts are added by the workspace owner.", values };
  }

  const parsed = signupSchema.safeParse({
    businessName: formData.get("businessName"),
    name: formData.get("name"),
    email: formData.get("email"),
    password: formData.get("password"),
    businessType: formData.get("businessType") ?? DEFAULT_BUSINESS_TYPE,
  });

  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? "form");
      fieldErrors[key] ??= issue.message;
    }
    return { fieldErrors, values };
  }

  const { businessName, name, email, password, businessType } = parsed.data;

  // Skipped where the database is a file on this machine: that is a desktop
  // install, whose very first screen is this form, and locking somebody out of
  // setting up the copy they just installed would be absurd. Hosted, this is
  // the door a script would walk through a thousand times.
  if (!dataStaysOnThisMachine()) {
    const address = await clientAddress();
    const allowed = await hit(`signup:ip:${address}`, SIGNUP_PER_IP);

    if (!allowed.ok) {
      return {
        error: `Too many workspaces have been created from here. Try again ${retryAfterPhrase(allowed.retryAfterSeconds)}.`,
        values,
      };
    }
  }

  const weak = passwordProblem(password);
  if (weak) return { fieldErrors: { password: weak }, values };

  const existing = await prisma.user.findFirst({ where: { email } });
  if (existing) {
    return {
      fieldErrors: { email: "An account already uses that email." },
      values,
    };
  }

  const slug = await uniqueSlug(businessName);
  const passwordHash = await hashPassword(password);

  const user = await prisma.$transaction(async (tx) => {
    const org = await tx.organization.create({
      data: {
        slug,
        name: businessName,
        email,
        businessType,
        // The preset's words, written onto the row rather than looked up on
        // every read: what the app renders is the organization's own
        // terminology, and changing a preset later must not silently rename
        // records for a business that has been using them for a year.
        ...vocabularyColumns(businessType),
        invoicePrefix: "INV-",
        estimatePrefix: "EST-",
        jobPrefix: "JOB-",
      },
    });

    return tx.user.create({
      data: {
        organizationId: org.id,
        email,
        name,
        passwordHash,
        role: "OWNER",
      },
    });
  });

  await rememberEmail(email);
  await createSession(user.id);
  // No free tier: a new business chooses its plan before anything else.
  redirect("/billing?welcome=1");
}

async function uniqueSlug(businessName: string) {
  const base = slugify(businessName) || "org";
  let candidate = base;
  let suffix = 2;

  while (await prisma.organization.findUnique({ where: { slug: candidate } })) {
    candidate = `${base}-${suffix++}`;
  }

  return candidate;
}

// ----------------------------------------------------------- forgot password ---

const resetRequestSchema = z.object({
  email: z.string().trim().toLowerCase().min(1, "Enter your email.").email("Enter a valid email."),
});

/**
 * "Email me a link." Answers the same whether or not the address has an
 * account, so the form cannot be used to find out who does.
 */
export async function requestPasswordResetAction(
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const values = { email: text(formData.get("email")) };

  const parsed = resetRequestSchema.safeParse({ email: formData.get("email") });
  if (!parsed.success) {
    return { fieldErrors: { email: parsed.error.issues[0]?.message ?? "Enter a valid email." }, values };
  }
  const { email } = parsed.data;

  // Before anything is looked up, like sign-in: a limited request costs
  // nothing, and says nothing about whether the address exists.
  const address = await clientAddress();
  const [perEmail, perAddress] = await Promise.all([
    hit(`reset:email:${email}`, RESET_REQUEST_PER_EMAIL),
    hit(`reset:ip:${address}`, RESET_REQUEST_PER_IP),
  ]);
  if (!perEmail.ok || !perAddress.ok) {
    const wait = Math.max(perEmail.retryAfterSeconds, perAddress.retryAfterSeconds);
    return { error: `Too many reset emails asked for. Try again ${retryAfterPhrase(wait)}.`, values };
  }

  const result = await requestReset(email);
  if (!result.ok) {
    console.error("[password-reset] No sending account: set SYSTEM_MAIL_* to send reset links.");
    return {
      error: "Password reset by email isn’t set up on this site yet. Ask the owner of your business to reset it from the Team page.",
      values,
    };
  }

  return { done: true, values };
}

const resetSchema = z.object({
  token: z.string().min(1),
  password: z.string(),
  confirm: z.string(),
});

/**
 * Choosing the new password from the emailed link.
 *
 * Saving it changes the hash, which is what retires the link. Every device
 * signed in as this person is signed out — whoever else knew the old
 * password is shut out with it — and this one is signed in.
 */
export async function resetPasswordAction(
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const parsed = resetSchema.safeParse({
    token: formData.get("token"),
    password: formData.get("password") ?? "",
    confirm: formData.get("confirm") ?? "",
  });
  if (!parsed.success) return { error: "Something went wrong. Please try again." };

  const user = await userForResetToken(parsed.data.token);
  if (!user) {
    return { error: "This link has expired or has already been used. Ask for a new one." };
  }

  const weak = passwordProblem(parsed.data.password);
  if (weak) return { fieldErrors: { password: weak } };
  if (parsed.data.password !== parsed.data.confirm) {
    return { fieldErrors: { confirm: "The two passwords don’t match." } };
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: await hashPassword(parsed.data.password) },
  });
  await destroyAllSessionsFor(user.id);

  // They proved they hold the mailbox; a lockout they collected while
  // forgetting is not theirs to wait out.
  await forget(`login:email:${user.email}`);

  const headerList = await headers();
  await createSession(user.id, {
    remember: true,
    userAgent: headerList.get("user-agent"),
    ipAddress: headerList.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
  });
  await rememberEmail(user.email);

  redirect("/dashboard");
}

