import { NextResponse } from "next/server";

import { deliverLicense } from "@/lib/checkout/deliver";
import { fulfilPurchase } from "@/lib/checkout/fulfil";
import { syncSubscription } from "@/lib/billing/subscription";
import {
  getSubscription,
  parseEvent,
  paypalConfig,
  planForPayPalId,
  subscriptionIdOf,
  verifyWebhook,
  webhookHeaders,
} from "@/lib/checkout/paypal";
import { licensePrivateKey } from "@/lib/license/private-key";

/**
 * Where a PayPal subscription becomes a licence.
 *
 * The only path in this application where money turns into an entitlement, so
 * the order of operations is deliberate:
 *
 *   1. verify the webhook really came from PayPal, before reading anything in it
 *   2. resolve the plan from PayPal's own records, never from the payload
 *   3. fulfil, idempotently, under PayPal's id for the payment
 *
 * Status codes are the retry protocol. PayPal resends anything that is not a
 * 2xx, so a transient failure must *not* answer 200 — that would drop a paid
 * sale permanently. Equally, a payload we will never be able to process must
 * not answer 500, or PayPal retries it for days.
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

  const verified = await verifyWebhook(
    config,
    webhookHeaders(request.headers),
    rawBody,
  );

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

  // A subscription started from inside the app pays for a business directly:
  // bring that business up to date with PayPal and stop. Every kind of change
  // lands here — a renewal, a failed payment, a cancellation — and the answer
  // is always the subscription as PayPal has it now.
  const subscriptionId = subscriptionIdOf(event);
  if (subscriptionId) {
    const synced = await syncSubscription(subscriptionId, { config });

    if (synced.linked) {
      return NextResponse.json({ ok: true, organization: synced.organizationId });
    }
    // Not a 200: PayPal retries a failed delivery, which is what should happen
    // while it cannot be asked about its own subscription.
    if (synced.reason === "unreachable") {
      return NextResponse.json({ error: "Could not load the subscription" }, { status: 503 });
    }
    // Otherwise it is not a business's subscription — the anonymous purchase
    // below, which emails a licence key for a desktop install.
  }

  const parsed = parseEvent(event);

  // Verified, but not an event that owes anyone a licence. Subscriptions emit
  // plenty of these; acknowledging them is how PayPal stops resending.
  if (!parsed) return NextResponse.json({ ok: true, ignored: true });

  // A renewal names only the subscription, so plan and subscriber come from
  // PayPal's record of it rather than from anything in the payload.
  let paypalPlanId = parsed.paypalPlanId;
  let email = parsed.email;

  if (!paypalPlanId || !email) {
    const subscription = await getSubscription(config, parsed.subscriptionId);

    // Could not ask. That is transient, so let PayPal retry rather than
    // acknowledge a sale that was never fulfilled.
    if (!subscription) {
      return NextResponse.json(
        { error: "Could not load the subscription" },
        { status: 503 },
      );
    }

    paypalPlanId = paypalPlanId || subscription.planId;
    email = email || subscription.email;
  }

  const matched = planForPayPalId(config, paypalPlanId);

  if (!matched) {
    // A real payment against a billing plan this deployment does not know.
    // Retrying will not help; someone has to add the plan id to the
    // environment, and a 200 stops PayPal hammering the endpoint meanwhile.
    console.error(
      `[checkout] Paid PayPal plan ${paypalPlanId} is not mapped. ` +
        `Subscription ${parsed.subscriptionId} is unfulfilled and needs issuing by hand.`,
    );
    return NextResponse.json({ ok: true, unmapped: true });
  }

  if (!email) {
    console.error(
      `[checkout] No email on subscription ${parsed.subscriptionId}; cannot issue a licence.`,
    );
    return NextResponse.json({ ok: true, unmapped: true });
  }

  const result = await fulfilPurchase(
    {
      provider: "PAYPAL",
      externalId: parsed.externalId,
      email,
      plan: matched.plan,
      months: matched.interval === "annual" ? 12 : 1,
      ...(parsed.amountCents === null ? {} : { amountCents: parsed.amountCents }),
      ...(parsed.currency === null ? {} : { currency: parsed.currency }),
    },
    { privateKey: licensePrivateKey() },
  );

  if (!result.ok) {
    // Signing failed, or the database was unreachable. Both are worth a retry,
    // and both need a human to look: the customer has paid.
    console.error(`[checkout] Fulfilment failed: ${result.error}`);
    return NextResponse.json({ error: result.error }, { status: 503 });
  }

  /*
   * Email the key, but never let mail decide whether the sale succeeded.
   *
   * A 503 here would make PayPal retry a fulfilment that already worked, and
   * the licence is safe regardless: it is stored on the purchase and shown on
   * the return page. So a failed send is logged and recorded on the row for
   * `npm run sale --deliver` to pick up, and the webhook still acknowledges.
   */
  const delivery = await deliverLicense(result.purchase);

  if (!delivery.ok) {
    console.error(
      `[checkout] Licence issued for ${result.purchase.email} but not sent: ${delivery.error}`,
    );
  }

  return NextResponse.json({
    ok: true,
    purchase: result.purchase.id,
    reissued: result.reissued,
    delivered: delivery.ok,
  });
}
