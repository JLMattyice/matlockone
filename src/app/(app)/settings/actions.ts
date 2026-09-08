"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import {
  failed,
  int,
  invalid,
  saved,
  text,
  type ActionState,
} from "@/lib/action-state";
import { requireContext, requirePermission } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { parseRateToBp } from "@/lib/money";
import { hashPassword, passwordProblem, verifyPassword } from "@/lib/password";
import { destroyAllSessionsFor } from "@/lib/session";
import { hexToRgbChannels } from "@/lib/utils";

const hexColor = z
  .string()
  .trim()
  .refine((v) => hexToRgbChannels(v) !== null, "Use a hex color such as #2563eb.");

// ------------------------------------------------------- business profile ---

const businessSchema = z.object({
  name: z.string().trim().min(2, "Business name is required."),
  legalName: z.string().trim().nullable(),
  email: z.string().trim().email("Enter a valid email.").nullable(),
  phone: z.string().trim().nullable(),
  website: z.string().trim().nullable(),
  addressLine1: z.string().trim().nullable(),
  addressLine2: z.string().trim().nullable(),
  city: z.string().trim().nullable(),
  state: z.string().trim().nullable(),
  postalCode: z.string().trim().nullable(),
  country: z.string().trim().min(2).max(2).nullable(),
  timeZone: z.string().trim().min(1),
  currency: z.string().trim().length(3, "Use a 3-letter currency code."),
  locale: z.string().trim().min(2),
});

export async function updateBusinessProfile(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { org } = await requirePermission("settings:write");

  const parsed = businessSchema.safeParse({
    name: formData.get("name"),
    legalName: text(formData, "legalName"),
    email: text(formData, "email"),
    phone: text(formData, "phone"),
    website: text(formData, "website"),
    addressLine1: text(formData, "addressLine1"),
    addressLine2: text(formData, "addressLine2"),
    city: text(formData, "city"),
    state: text(formData, "state"),
    postalCode: text(formData, "postalCode"),
    country: text(formData, "country")?.toUpperCase() ?? null,
    timeZone: formData.get("timeZone"),
    currency: String(formData.get("currency") ?? "USD").toUpperCase(),
    locale: formData.get("locale"),
  });

  if (!parsed.success) return invalid(parsed.error);

  await prisma.organization.update({
    where: { id: org.id },
    data: { ...parsed.data, country: parsed.data.country ?? "US" },
  });

  revalidatePath("/settings");
  revalidatePath("/dashboard");
  return saved("Business profile updated.");
}

// --------------------------------------------------------------- branding ---

const brandingSchema = z.object({
  primaryColor: hexColor,
  accentColor: hexColor,
  logoUrl: z.string().trim().nullable(),
  labelJobSingular: z.string().trim().min(1, "Required."),
  labelJobPlural: z.string().trim().min(1, "Required."),
  labelClientSingular: z.string().trim().min(1, "Required."),
  labelClientPlural: z.string().trim().min(1, "Required."),
});

export async function updateBranding(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { org } = await requirePermission("settings:write");

  const parsed = brandingSchema.safeParse({
    primaryColor: formData.get("primaryColor"),
    accentColor: formData.get("accentColor"),
    logoUrl: text(formData, "logoUrl"),
    labelJobSingular: formData.get("labelJobSingular"),
    labelJobPlural: formData.get("labelJobPlural"),
    labelClientSingular: formData.get("labelClientSingular"),
    labelClientPlural: formData.get("labelClientPlural"),
  });

  if (!parsed.success) return invalid(parsed.error);

  await prisma.organization.update({
    where: { id: org.id },
    data: parsed.data,
  });

  // The sidebar, nav labels and brand color all live in the app layout.
  revalidatePath("/", "layout");
  return saved("Branding updated.");
}

// ------------------------------------------------------ document defaults ---

export async function updateDocumentDefaults(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { org } = await requirePermission("settings:write");

  const taxRateBp = parseRateToBp(text(formData, "taxRate")) ?? 0;
  if (taxRateBp < 0 || taxRateBp > 10_000) {
    return { ok: false, fieldErrors: { taxRate: "Enter a rate between 0 and 100." } };
  }

  const invoiceNextNumber = int(formData, "invoiceNextNumber") ?? org.invoiceNextNumber;
  const estimateNextNumber = int(formData, "estimateNextNumber") ?? org.estimateNextNumber;
  const jobNextNumber = int(formData, "jobNextNumber") ?? org.jobNextNumber;

  // Counters only ever move forward — rewinding one would mint a number that
  // an existing invoice or estimate already uses.
  const fieldErrors: Record<string, string> = {};
  if (invoiceNextNumber < org.invoiceNextNumber) {
    fieldErrors.invoiceNextNumber = `Cannot go below the current counter (${org.invoiceNextNumber}).`;
  }
  if (estimateNextNumber < org.estimateNextNumber) {
    fieldErrors.estimateNextNumber = `Cannot go below the current counter (${org.estimateNextNumber}).`;
  }
  if (jobNextNumber < org.jobNextNumber) {
    fieldErrors.jobNextNumber = `Cannot go below the current counter (${org.jobNextNumber}).`;
  }
  if (Object.keys(fieldErrors).length) return { ok: false, fieldErrors };

  const paymentTerms = int(formData, "defaultPaymentTermsDays") ?? 30;
  const validDays = int(formData, "defaultEstimateValidDays") ?? 30;

  await prisma.organization.update({
    where: { id: org.id },
    data: {
      defaultTaxRateBp: taxRateBp,
      invoicePrefix: text(formData, "invoicePrefix") ?? "INV-",
      estimatePrefix: text(formData, "estimatePrefix") ?? "EST-",
      jobPrefix: text(formData, "jobPrefix") ?? "JOB-",
      invoiceNextNumber,
      estimateNextNumber,
      jobNextNumber,
      defaultPaymentTermsDays: Math.max(0, Math.min(paymentTerms, 365)),
      defaultEstimateValidDays: Math.max(1, Math.min(validDays, 365)),
      invoiceFooter: text(formData, "invoiceFooter"),
      estimateFooter: text(formData, "estimateFooter"),
    },
  });

  revalidatePath("/settings/documents");
  return saved("Document defaults updated.");
}

// --------------------------------------------------------- own profile ---

const profileSchema = z.object({
  name: z.string().trim().min(2, "Enter your name."),
  email: z.string().trim().toLowerCase().email("Enter a valid email."),
  phone: z.string().trim().nullable(),
  position: z.string().trim().nullable(),
});

export async function updateOwnProfile(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { user } = await requireContext();

  const parsed = profileSchema.safeParse({
    name: formData.get("name"),
    email: formData.get("email"),
    phone: text(formData, "phone"),
    position: text(formData, "position"),
  });

  if (!parsed.success) return invalid(parsed.error);

  const clash = await prisma.user.findFirst({
    where: {
      organizationId: user.organizationId,
      email: parsed.data.email,
      id: { not: user.id },
    },
    select: { id: true },
  });

  if (clash) {
    return { ok: false, fieldErrors: { email: "Someone on your team already uses that email." } };
  }

  await prisma.user.update({ where: { id: user.id }, data: parsed.data });

  revalidatePath("/", "layout");
  return saved("Profile updated.");
}

export async function changeOwnPassword(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { user } = await requireContext();

  const current = String(formData.get("currentPassword") ?? "");
  const next = String(formData.get("newPassword") ?? "");
  const confirm = String(formData.get("confirmPassword") ?? "");

  if (next !== confirm) {
    return { ok: false, fieldErrors: { confirmPassword: "Passwords do not match." } };
  }

  const weak = passwordProblem(next);
  if (weak) return { ok: false, fieldErrors: { newPassword: weak } };

  const record = await prisma.user.findUnique({
    where: { id: user.id },
    select: { passwordHash: true },
  });
  if (!record) return failed("Account not found.");

  if (!(await verifyPassword(current, record.passwordHash))) {
    return { ok: false, fieldErrors: { currentPassword: "That is not your current password." } };
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: await hashPassword(next) },
  });

  // Every other device is signed out; this one keeps its session.
  await destroyAllSessionsFor(user.id);

  return saved("Password changed. Other devices have been signed out.");
}
