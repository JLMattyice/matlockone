import { NextResponse } from "next/server";

import { isPlan } from "@/lib/checkout/plans";
import { paypalConfig, startSubscription } from "@/lib/checkout/paypal";

/**
 * Starts a subscription and hands back where to send the buyer.
 *
 * The plan is read from the request, but only as a name to look up — the price
 * belongs to the PayPal billing plan, not to anything a browser sends. Posting
 * a different plan id here gets you a different subscription at that plan's
 * real price, never a cheaper one.
 */

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const config = paypalConfig();
  if (!config) {
    return NextResponse.json(
      { error: "Checkout is not configured on this deployment." },
      { status: 404 },
    );
  }

  let body: { plan?: unknown; interval?: unknown; email?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Malformed request." }, { status: 400 });
  }

  if (!isPlan(body.plan)) {
    return NextResponse.json({ error: "Unknown plan." }, { status: 400 });
  }

  const interval = body.interval === "monthly" ? "monthly" : "annual";

  // Built from the request's own origin so the same code works on a preview
  // deployment, a staging host and production without another variable to keep
  // in step.
  const origin = new URL(request.url).origin;

  const result = await startSubscription(config, {
    plan: body.plan,
    interval,
    returnUrl: `${origin}/checkout/thanks`,
    cancelUrl: `${origin}/#pricing`,
    email: typeof body.email === "string" ? body.email : null,
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 502 });
  }

  return NextResponse.json({
    approveUrl: result.approveUrl,
    subscriptionId: result.subscriptionId,
  });
}
