"use server";

import { revalidatePath } from "next/cache";

import { failed, saved, type ActionState } from "@/lib/action-state";
import { requirePermission } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { licensePublicKey } from "@/lib/license/public-key";
import { verifyLicense } from "@/lib/license/token";

/**
 * Storing a licence key.
 *
 * The key is verified before it is written, so an unreadable licence can never
 * become the workspace's saved state. A rejected key leaves whatever was there
 * before untouched — pasting the wrong thing must not cost someone the licence
 * they already had.
 */
export async function activateLicense(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  // Reachable unpaid: a desktop install with no licence is closed until it has
  // one, and this is how it gets one — from the billing screen.
  const { org } = await requirePermission("settings:write", { unpaid: "allow" });

  const key = String(formData.get("licenseKey") ?? "")
    .trim()
    // Mail clients wrap long strings, and the key arrives by email. Rejecting
    // a correct licence because it came back with a newline in it would be a
    // support call for something the software can simply fix.
    .replace(/\s+/g, "");

  if (!key) {
    return { ok: false, fieldErrors: { licenseKey: "Paste your licence key." } };
  }

  const result = verifyLicense(key, licensePublicKey());

  if (!result.ok) {
    return { ok: false, fieldErrors: { licenseKey: result.message } };
  }

  await prisma.organization.update({
    where: { id: org.id },
    data: { licenseKey: key },
  });

  // The banner lives in the application shell, so the whole layout is stale.
  revalidatePath("/", "layout");

  return saved(
    result.license.seats === null
      ? "Licence activated. Unlimited people."
      : `Licence activated. ${result.license.seats} ${result.license.seats === 1 ? "person" : "people"}.`,
  );
}

/**
 * Removes the stored licence. The install then closes until a key is entered
 * again, unless it is exempt from billing.
 *
 * Here so a business moving an installation to another machine can take its
 * licence off the old one. Nothing is deleted but the key itself.
 */
export async function clearLicense(): Promise<void> {
  const { org } = await requirePermission("settings:write");

  await prisma.organization.update({
    where: { id: org.id },
    data: { licenseKey: null },
  });

  // No return value: this is a plain form action, and the next screen — the
  // key form on the billing page — says what happened more plainly than a
  // toast would.
  revalidatePath("/", "layout");
}
