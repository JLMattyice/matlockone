import { NextResponse } from "next/server";

import { autopayInvite, startAutopay } from "@/lib/autopay";
import { hit, PAY_REDIRECT_PER_INVOICE } from "@/lib/rate-limit";
import { shareAllowed, shareMissed } from "@/lib/share-guard";

/**
 * Sends a customer from their auto-pay invite on to PayPal to approve it.
 *
 * The subscription is made here, when they click, because PayPal's approval
 * link goes stale within hours and the invite may be opened days after it
 * was sent. PayPal brings them back to the invite, which then says whether it
 * worked.
 *
 * Every hit can make a subscription at the business's PayPal, so it is
 * counted per invite before anything is looked up, and an address that has
 * tried too many links that do not exist is turned away first — the same
 * guards as the invoice pay route.
 */

export const dynamic = "force-dynamic";

function back(origin: string, token: string, problem: string) {
  return NextResponse.redirect(new URL(`/share/autopay/${token}?problem=${problem}`, origin));
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const { origin } = new URL(request.url);

  if (!(await shareAllowed()).ok) return back(origin, token, "too-many");

  const allowed = await hit(`autopay:${token}`, PAY_REDIRECT_PER_INVOICE);
  if (!allowed.ok) return back(origin, token, "too-many");

  if (!(await autopayInvite(token))) {
    await shareMissed();
    return NextResponse.redirect(new URL(`/share/autopay/${token}`, origin));
  }

  const page = `${origin}/share/autopay/${token}`;
  const started = await startAutopay(token, {
    returnUrl: `${page}?done=1`,
    cancelUrl: `${page}?cancelled=1`,
  });

  if (!started.ok) return back(origin, token, "unavailable");
  if ("alreadyOn" in started.value) return NextResponse.redirect(new URL(page));

  return NextResponse.redirect(started.value.redirect);
}
