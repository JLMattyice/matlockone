import { timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import { MIN_CRON_SECRET } from "@/lib/config";
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

  const result = await sweepEveryBusiness();

  console.info(
    `[automations] morning run: ${result.businesses} businesses, ${result.created} tasks raised` +
      (result.failed.length > 0 ? `, ${result.failed.length} failed` : ""),
  );

  return NextResponse.json(result);
}
