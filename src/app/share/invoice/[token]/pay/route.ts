import { NextResponse } from "next/server";

import { resolveProcessor } from "@/lib/payments/account";
import { createCheckoutSession } from "@/lib/payments/clover";
import { canTakePayment } from "@/lib/payments/link";
import { hit, PAY_REDIRECT_PER_INVOICE } from "@/lib/rate-limit";
import { prisma } from "@/lib/db";
import { shareAllowed, shareMissed } from "@/lib/share-guard";

/**
 * Sends a client on to a payment page that has to be made at the last moment.
 *
 * Clover's hosted checkout expires fifteen minutes after it is created, so the
 * address on the invoice is this route rather than Clover's. The session is
 * minted here, when somebody actually clicks, and they are redirected straight
 * to it — the fifteen minutes start when they can be useful.
 *
 * Addressed by the invoice's public token, like the page it sits under: the
 * client following it is not signed in and never will be.
 *
 * A failure redirects back to the invoice with a flag rather than showing an
 * error of its own. Someone who wanted to pay should land on their invoice and
 * its other ways to pay, not on a stack trace.
 */

export const dynamic = "force-dynamic";

/**
 * Redirects must be absolute, and the request's own URL is the honest source
 * for the origin — behind a proxy it is what the client actually reached.
 *
 * Passed through rather than held in a module variable: a module variable is
 * shared by every request the server is handling at once, so two clients
 * paying two invoices at the same moment would overwrite each other's.
 */
function back(origin: string, token: string, reason: string) {
  return NextResponse.redirect(
    new URL(`/share/invoice/${token}?pay=${reason}`, origin),
  );
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const { origin } = new URL(request.url);

  // Counted per invoice, before anything is looked up. This route calls a
  // processor on every hit, so a token in the wrong hands is a way to make
  // Matlock One hammer somebody's merchant account. Keyed on the token rather
  // than the caller: the caller is unauthenticated and can come from anywhere,
  // while the thing being abused is the one invoice.
  // The address first: one that has tried too many links that do not exist
  // is turned away before this token costs a row of its own.
  if (!(await shareAllowed()).ok) return back(origin, token, "too-many");

  const allowed = await hit(`pay:invoice:${token}`, PAY_REDIRECT_PER_INVOICE);
  if (!allowed.ok) return back(origin, token, "too-many");

  const invoice = await prisma.invoice.findUnique({
    where: { publicToken: token },
    select: {
      number: true,
      title: true,
      status: true,
      balanceCents: true,
      organizationId: true,
      client: { select: { displayName: true, email: true } },
      organization: { select: { name: true, isDemo: true } },
    },
  });

  // The same silence as the page above: an unknown token says nothing about
  // whether an invoice exists.
  if (!invoice) {
    await shareMissed();
    return back(origin, token, "unavailable");
  }

  // A draft was never issued, a cancelled invoice is not owed, and a settled
  // one must not take a second payment.
  if (!canTakePayment(invoice)) return back(origin, token, "not-payable");

  // A demo invoice is for looking at. Nobody should be sent to pay it.
  if (invoice.organization.isDemo) return back(origin, token, "not-payable");

  const processor = await resolveProcessor(invoice.organizationId);
  if (!processor) return back(origin, token, "unavailable");

  // Only Clover routes through here. Any other processor's link goes straight
  // to the processor, so arriving here with one means the invoice was linked
  // before the account changed — send them to the invoice, which carries the
  // link that was actually made for it.
  if (processor.provider !== "CLOVER") {
    return NextResponse.redirect(new URL(`/share/invoice/${token}`, origin));
  }

  const session = await createCheckoutSession(
    {
      number: invoice.number,
      description: invoice.title ?? `Invoice ${invoice.number}`,
      // Always the outstanding balance, read now rather than when the link
      // was made: a deposit may have landed since the email went out.
      balanceCents: invoice.balanceCents,
      clientName: invoice.client.displayName,
      clientEmail: invoice.client.email,
      organizationName: invoice.organization.name,
    },
    processor.config,
    processor.credentials,
  );

  if (!session.ok) return back(origin, token, "unavailable");

  return NextResponse.redirect(session.value.url);
}
