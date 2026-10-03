import { createHash } from "node:crypto";

/**
 * A customer's electronic signature on an estimate.
 *
 * The owner chose a typed name over a drawn one: the customer ticks "I
 * agree" and types their full name. Under the US E-SIGN Act what makes that a
 * signature is the intent and the record, so the record is what this module
 * is for — who typed what, when, from which address and browser, and exactly
 * which version of the estimate they were looking at.
 *
 * The snapshot is the estimate as the customer saw it, in a fixed shape; the
 * hash is its SHA-256. An accepted estimate cannot be edited here, but the
 * snapshot does not depend on that — it is what was signed, whatever happens
 * to the rows afterwards.
 */

export type SignableEstimate = {
  number: string;
  title: string | null;
  issueDate: Date;
  expiresAt: Date | null;
  subtotalCents: number;
  discountCents: number;
  taxRateBp: number;
  taxCents: number;
  totalCents: number;
  notes: string | null;
  terms: string | null;
  lineItems: {
    name: string;
    description: string | null;
    quantity: number;
    unit: string;
    unitPriceCents: number;
    totalCents: number;
  }[];
};

/** The estimate as signed, in a shape that serializes the same way every time. */
export function signedSnapshot(estimate: SignableEstimate): string {
  return JSON.stringify({
    number: estimate.number,
    title: estimate.title,
    issueDate: estimate.issueDate.toISOString(),
    expiresAt: estimate.expiresAt?.toISOString() ?? null,
    lines: estimate.lineItems.map((line) => [
      line.name,
      line.description,
      line.quantity,
      line.unit,
      line.unitPriceCents,
      line.totalCents,
    ]),
    subtotalCents: estimate.subtotalCents,
    discountCents: estimate.discountCents,
    taxRateBp: estimate.taxRateBp,
    taxCents: estimate.taxCents,
    totalCents: estimate.totalCents,
    notes: estimate.notes,
    terms: estimate.terms,
  });
}

export function snapshotHash(snapshot: string): string {
  return createHash("sha256").update(snapshot).digest("hex");
}

/** A typed name worth calling a signature: a real name's length, no control characters. */
export function cleanSignatureName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
  return name.length >= 2 && name.length <= 120 ? name : null;
}

/**
 * Where the request came from. Behind Vercel the first x-forwarded-for entry
 * is the visitor; a desktop install has no proxy and reports nothing.
 */
export function requestAddress(headers: Headers): string | null {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const address = forwarded || headers.get("x-real-ip")?.trim();
  return address ? address.slice(0, 64) : null;
}
