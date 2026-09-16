"use server";

import { redirect } from "next/navigation";
import { z } from "zod";

import { login, logout } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { hashPassword, passwordProblem } from "@/lib/password";
import { forgetRememberedEmail, rememberEmail } from "@/lib/remembered-email";
import { createSession } from "@/lib/session";
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
};

/**
 * FormData.get() returns string | File | null. Only the string form is ever a
 * field on these forms, and the rest is not worth echoing back.
 */
function text(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value : "";
}

const loginSchema = z.object({
  email: z.string().trim().min(1, "Email is required.").email("Enter a valid email."),
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

  const result = await login(parsed.data.email, parsed.data.password, { remember });
  if (!result.ok) return { error: result.error, values };

  // Only once the credentials were right, so a mistyped address is not the one
  // waiting on the screen next time.
  if (remember) await rememberEmail(result.user.email);
  else await forgetRememberedEmail();

  // Only accept same-origin relative paths, so ?next= cannot bounce a user
  // to an attacker-controlled site after a successful sign-in.
  const next = parsed.data.next;
  const safeNext =
    next && next.startsWith("/") && !next.startsWith("//") ? next : "/dashboard";

  redirect(safeNext);
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
  };

  if (process.env.ALLOW_SIGNUP === "false") {
    return { error: "Signup is disabled on this installation.", values };
  }

  const parsed = signupSchema.safeParse({
    businessName: formData.get("businessName"),
    name: formData.get("name"),
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? "form");
      fieldErrors[key] ??= issue.message;
    }
    return { fieldErrors, values };
  }

  const { businessName, name, email, password } = parsed.data;

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
  redirect("/dashboard");
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
