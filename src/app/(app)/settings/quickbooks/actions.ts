"use server";

import { revalidatePath } from "next/cache";

import { failed, saved, type ActionState } from "@/lib/action-state";
import { requirePermission } from "@/lib/auth";
import { markFirstSent, removeConnection, setOverwriteMatches } from "@/lib/quickbooks/connection";
import { revokeTokens } from "@/lib/quickbooks/oauth";
import { quickbooksSettings } from "@/lib/quickbooks/settings";
import { syncCustomers } from "@/lib/quickbooks/sync";

function count(n: number, one: string, many: string) {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

/**
 * Send now. The first press is also what switches on sending by itself, so
 * nothing reaches QuickBooks before the owner has seen the overwrite switch.
 */
export async function sendToQuickBooksNow(
  _prev: ActionState,
  _form: FormData,
): Promise<ActionState> {
  const { org } = await requirePermission("settings:write");

  const result = await syncCustomers(org.id, { start: true, budgetMs: 45_000 });
  revalidatePath("/settings/quickbooks");

  if (result.skipped === "not-connected") return failed("QuickBooks is not connected.");
  if (result.skipped === "reconnect") {
    return failed("QuickBooks needs connecting again before anything can be sent.");
  }

  await markFirstSent(org.id);

  if (result.sent === 0 && result.failed === 0 && result.remaining === 0) {
    return saved("Everything is already in QuickBooks.");
  }

  const parts: string[] = [];
  if (result.sent > 0) parts.push(`${count(result.sent, "customer", "customers")} sent to QuickBooks.`);
  if (result.failed > 0) {
    parts.push(
      result.sent > 0
        ? `${count(result.failed, "could", "could")} not be — see below.`
        : `${count(result.failed, "customer", "customers")} could not be sent — see below.`,
    );
  }
  if (result.remaining > 0) {
    parts.push(
      `The other ${result.remaining.toLocaleString("en-US")} will follow on the next Send now or the morning run.`,
    );
  }
  return result.failed > 0 ? failed(parts.join(" ")) : saved(parts.join(" "));
}

export async function setQuickBooksOverwrite(formData: FormData) {
  const { org } = await requirePermission("settings:write");
  await setOverwriteMatches(org.id, formData.get("overwrite") === "on");
  revalidatePath("/settings/quickbooks");
}

/**
 * Disconnect: forget the tokens here and hand them back to Intuit. Nothing
 * already in QuickBooks is touched.
 */
export async function disconnectQuickBooks() {
  const { org } = await requirePermission("settings:write");
  const connection = await removeConnection(org.id);
  const settings = quickbooksSettings();
  if (connection && settings) await revokeTokens(settings, connection.tokens);
  revalidatePath("/settings/quickbooks");
}
