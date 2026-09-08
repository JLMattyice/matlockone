"use server";

import { redirect } from "next/navigation";
import { z } from "zod";

import { login, logout } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { hashPassword, passwordProblem } from "@/lib/password";
import { forgetRememberedEmail, rememberEmail } from "@/lib/remembered-email";
import { createSession } from "@/lib/session";
import { slugify } from "@/lib/utils";

export type AuthFormState = { error?: string; fieldErrors?: Record<string, string> };

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
    if (orphan) return { error: "Something went wrong. Please try again." };
    return { fieldErrors };
  }

  const { remember } = parsed.data;

  const result = await login(parsed.data.email, parsed.data.password, { remember });
  if (!result.ok) return { error: result.error };

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
  if (process.env.ALLOW_SIGNUP === "false") {
    return { error: "Signup is disabled on this installation." };
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
    return { fieldErrors };
  }

  const { businessName, name, email, password } = parsed.data;

  const weak = passwordProblem(password);
  if (weak) return { fieldErrors: { password: weak } };

  const existing = await prisma.user.findFirst({ where: { email } });
  if (existing) {
    return { fieldErrors: { email: "An account already uses that email." } };
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
