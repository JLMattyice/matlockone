"use server";

import { revalidatePath } from "next/cache";

import { failed, saved, type ActionState } from "@/lib/action-state";
import { requirePermission } from "@/lib/auth";
import {
  loadConnection,
  markFirstSent,
  removeConnection,
  setExpenseAccounts,
  setOverwriteMatches,
  setSendFrom,
} from "@/lib/quickbooks/connection";
import { accountChoices } from "@/lib/quickbooks/expenses";
import { EXPENSE_CATEGORIES } from "@/lib/constants";
import { revokeTokens } from "@/lib/quickbooks/oauth";
import { quickbooksSettings } from "@/lib/quickbooks/settings";
import { sendToQuickBooksSoon, syncQuickBooks, type SyncResult } from "@/lib/quickbooks/sync";

function count(n: number, one: string, many: string) {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

/** "3 customers, 2 invoices and 1 payment" — only the kinds counted. */
function kindsList(result: SyncResult, which: "sent" | "failed") {
  const parts = [
    result.kinds.customers[which] ? count(result.kinds.customers[which], "customer", "customers") : null,
    result.kinds.invoices[which] ? count(result.kinds.invoices[which], "invoice", "invoices") : null,
    result.kinds.payments[which] ? count(result.kinds.payments[which], "payment", "payments") : null,
    result.kinds.expenses[which] ? count(result.kinds.expenses[which], "expense", "expenses") : null,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : (parts[0] ?? "");
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

  const result = await syncQuickBooks(org.id, { start: true, budgetMs: 45_000 });
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
  if (result.sent > 0) parts.push(`Sent to QuickBooks: ${kindsList(result, "sent")}.`);
  if (result.failed > 0) parts.push(`${kindsList(result, "failed")} could not be sent — see below.`);
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

/**
 * The day invoices and expenses start going over from. Moving it earlier
 * sends what was skipped (once sending has started); moving it later sends
 * nothing more but takes nothing back out.
 */
export async function setQuickBooksStartDate(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { org } = await requirePermission("settings:write");
  const value = String(formData.get("sendFrom") ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) {
    return failed("Choose a date.");
  }
  await setSendFrom(org.id, value);
  await sendToQuickBooksSoon(org.id);
  revalidatePath("/settings/quickbooks");
  return saved("Start date saved.");
}

/**
 * Where each expense category lands, and what pays for it. Checked against
 * the company's own accounts, so an id from a tampered form, or from a
 * company since disconnected, is refused rather than sent.
 */
export async function saveQuickBooksExpenseAccounts(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { org } = await requirePermission("settings:write");
  const connection = await loadConnection(org.id);
  if (!connection) return failed("QuickBooks is not connected.");

  let choices;
  try {
    choices = await accountChoices(connection);
  } catch {
    return failed("QuickBooks could not be reached for its accounts. Try again in a minute.");
  }

  const expenseIds = new Set(choices.expense.map((account) => account.id));
  const expenseAccounts: Record<string, string> = {};
  for (const category of EXPENSE_CATEGORIES) {
    const id = String(formData.get(`category:${category}`) ?? "");
    if (id && expenseIds.has(id)) expenseAccounts[category] = id;
  }

  const paidFromId = String(formData.get("paidFrom") ?? "");
  const paidFrom = choices.paidFrom.find((account) => account.id === paidFromId) ?? null;

  await setExpenseAccounts(org.id, {
    expenseAccounts,
    paidFromAccountId: paidFrom?.id ?? null,
    paidFromIsCard: paidFrom?.type === "Credit Card",
  });
  await sendToQuickBooksSoon(org.id);
  revalidatePath("/settings/quickbooks");
  return saved(paidFrom ? "Expense accounts saved." : "Saved. Expenses wait until an account to pay them from is chosen.");
}
