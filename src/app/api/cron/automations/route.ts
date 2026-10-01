import { timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import { MIN_CRON_SECRET } from "@/lib/config";
import { syncAutopay } from "@/lib/autopay";
import { sweepPayLinks } from "@/lib/payments/reconcile";
import { recordDueExpenses } from "@/lib/recurring-expenses";
import { draftDueInvoices } from "@/lib/recurring-invoices";
import { sweepEveryBusiness } from "@/lib/workflows/run";

/**
 * The morning run of the automations that wait for a date.
 *
 * Vercel calls this on the schedule in vercel.json, sending CRON_SECRET as a
 * bearer token. It does what pressing Check now does, for every business that
 * has one of those automations on — so an invoice that went overdue over the
 * weekend is chased on Monday whether or not anybody opened Settings.
 *
 * Refused without the secret, and refused when the deployment has none: an
 * address anybody can call that makes the database walk every business is a
 * way to make it slow for everyone. The sweep itself is safe to repeat — each
 * automation fires once per invoice or customer, however often it runs — so a
 * second call on the same morning does nothing but look.
 *
 * Repeating invoices ride the same run: their drafts are due on a date too,
 * and each date is claimed once, so a second call makes no second draft.
 * Auto-pay is checked after the drafts, so a payment PayPal took this
 * morning finds this morning's invoice to land on.
 *
 * Repeating expenses come last: a bill recorded or a reminder raised waits
 * on nothing else in the run.
 *
 * Pay links are checked first of all. A client who paid last night must not
 * be chased this morning because the notice went astray, so every open link
 * is asked about before the overdue automation looks at anything.
 */

export const dynamic = "force-dynamic";

// Every business in one call. A handful take seconds; the ceiling is here so a
// slow morning is cut off and logged rather than billed indefinitely.
export const maxDuration = 60;

/** Compared in constant time, so the answer's timing does not leak the secret. */
function authorized(header: string | null, secret: string): boolean {
  const expected = Buffer.from(`Bearer ${secret}`);
  const given = Buffer.from(header ?? "");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET?.trim() ?? "";

  if (secret.length < MIN_CRON_SECRET) {
    return NextResponse.json(
      { error: "Scheduled automations are not configured on this deployment." },
      { status: 503 },
    );
  }

  if (!authorized(request.headers.get("authorization"), secret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const payLinks = await sweepPayLinks();
  const result = await sweepEveryBusiness();
  const repeating = await draftDueInvoices();
  const autopay = await syncAutopay();
  const bills = await recordDueExpenses();
  const billsRecorded = bills.done.filter((item) => item.kind === "recorded").length;

  console.info(
    `[automations] morning run: pay links: ${payLinks.checked} checked, ${payLinks.recorded} payments recorded` +
      (payLinks.failed > 0 ? `, ${payLinks.failed} failed` : "") +
      (payLinks.stoppedEarly ? ", stopped for time" : "") +
      `; ${result.businesses} businesses, ${result.created} tasks raised` +
      (result.failed.length > 0 ? `, ${result.failed.length} failed` : "") +
      `; ${repeating.drafted.length} repeating invoices drafted` +
      (repeating.failed.length > 0 ? `, ${repeating.failed.length} schedules failed` : "") +
      `; auto-pay: ${autopay.checked} checked, ${autopay.collected} payments recorded` +
      (autopay.unmatched > 0 ? `, ${autopay.unmatched} waiting for their invoice` : "") +
      (autopay.failed.length > 0 ? `, ${autopay.failed.length} failed` : "") +
      `; repeating expenses: ${billsRecorded} recorded, ${bills.done.length - billsRecorded} to enter` +
      (bills.failed.length > 0 ? `, ${bills.failed.length} schedules failed` : ""),
  );

  return NextResponse.json({
    ...result,
    payLinksChecked: payLinks.checked,
    payLinksRecorded: payLinks.recorded,
    payLinksFailed: payLinks.failed,
    drafted: repeating.drafted.length,
    draftFailed: repeating.failed,
    autopayCollected: autopay.collected,
    autopayFailed: autopay.failed,
    expensesRecorded: billsRecorded,
    expensesToEnter: bills.done.length - billsRecorded,
    expensesFailed: bills.failed,
  });
}
