import { NextResponse } from "next/server";

import { handlePaypalNotice } from "@/lib/payments/paypal-notices";
import { noticeFrom, organizationForHook } from "@/lib/payments/paypal-webhooks";
import { hit, PAYMENT_NOTICES_PER_BUSINESS } from "@/lib/rate-limit";

/**
 * Where a business's own PayPal app says one of its invoices was paid.
 *
 * Not to be confused with /api/checkout/paypal/webhook, which hears about
 * businesses paying Matlock One. This one hears about their customers paying
 * them, and the address it is reached on says which business — registered on
 * that business's PayPal app by ensurePaypalWebhook.
 *
 * Nothing in the body is believed beyond which invoice it concerns: the payment
 * itself is read back from PayPal with the business's credentials before
 * anything is written. See paypal-webhooks.ts.
 *
 * Status codes are PayPal's retry protocol. Anything but a 2xx is resent for
 * days, so only "PayPal could not be reached just now" answers with an error;
 * a notice about something that is not ours is acknowledged and dropped.
 */

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ hook: string }> },
) {
  const { hook } = await params;

  // An address Matlock One did not make looks exactly like one that was never
  // there, before any work is done on its behalf.
  const organizationId = organizationForHook(hook);
  if (!organizationId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const allowed = await hit(`paypal-notice:${organizationId}`, PAYMENT_NOTICES_PER_BUSINESS);
  if (!allowed.ok) {
    return NextResponse.json(
      { error: "Too many notices" },
      { status: 429, headers: { "Retry-After": String(allowed.retryAfterSeconds) } },
    );
  }

  let event: unknown;
  try {
    event = JSON.parse(await request.text());
  } catch {
    return NextResponse.json({ error: "Malformed" }, { status: 400 });
  }

  const notice = noticeFrom(event);
  if (!notice) return NextResponse.json({ ok: true, ignored: true });

  try {
    const outcome = await handlePaypalNotice(organizationId, notice);

    if (outcome === "retry") {
      return NextResponse.json({ error: "Could not reach PayPal" }, { status: 503 });
    }
    return NextResponse.json({ ok: true, outcome });
  } catch (error) {
    // Unexpected, and possibly passing — a database hiccup. Worth PayPal's
    // trying again rather than a payment dropped on the floor.
    console.error("[payments] PayPal notice failed", error);
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}
