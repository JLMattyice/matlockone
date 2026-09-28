import { NextResponse } from "next/server";

import { syncSubscription } from "@/lib/billing/subscription";
import {
  paypalConfig,
  subscriptionIdOf,
  verifyWebhook,
  webhookHeaders,
} from "@/lib/checkout/paypal";

/**
 * Where PayPal says a business's subscription changed: it started, was paid
 * again, failed a payment, was cancelled.
 *
 * The order of operations is deliberate:
 *
 *   1. verify the webhook really came from PayPal, before reading anything in it
 *   2. take only the subscription's id from it
 *   3. ask PayPal where that subscription stands, and bring the business up to
 *      date with the answer (syncSubscription)
 *
 * Status codes are the retry protocol. PayPal resends anything that is not a
 * 2xx, so a transient failure must *not* answer 200 — that would drop a
 * renewal. Equally, an event we will never act on must not answer 500, or
 * PayPal retries it for days.
 */

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const config = paypalConfig();

  // A deployment that does not sell — a desktop install, a developer's laptop
  // — has no business exposing this endpoint at all.
  if (!config) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Raw, unparsed: the signature covers these exact bytes, and re-serialising
  // JSON changes them.
  const rawBody = await request.text();

  const verified = await verifyWebhook(config, webhookHeaders(request.headers), rawBody);

  if (!verified) {
    // Nothing in an unverified body is read, logged or acted on.
    return NextResponse.json({ error: "Unverified" }, { status: 401 });
  }

  let event: unknown;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Malformed" }, { status: 400 });
  }

  // Verified, but not about a subscription. Acknowledged, which is how PayPal
  // stops resending it.
  const subscriptionId = subscriptionIdOf(event);
  if (!subscriptionId) return NextResponse.json({ ok: true, ignored: true });

  const synced = await syncSubscription(subscriptionId, { config });

  if (synced.linked) {
    return NextResponse.json({ ok: true, organization: synced.organizationId });
  }

  // Not a 200: PayPal retries a failed delivery, which is what should happen
  // while it cannot be asked about its own subscription.
  if (synced.reason === "unreachable") {
    return NextResponse.json({ error: "Could not load the subscription" }, { status: 503 });
  }

  // Not a business of ours, or a plan this deployment does not sell. Retrying
  // will not change either, so it is acknowledged; the plan case is logged
  // where syncSubscription found it.
  return NextResponse.json({ ok: true, ignored: synced.reason });
}
