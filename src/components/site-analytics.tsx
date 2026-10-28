"use client";

import { Analytics } from "@vercel/analytics/next";

import { cleanVisitUrl } from "@/lib/visit-url";

/**
 * Counts visits to the public side of Matlock One — the website, signing up
 * and in, and the billing screen — with Vercel Web Analytics, so the operator
 * can see how many people come, where from, and how far they get before
 * making an account.
 *
 * Vercel's counter sets no cookies and cannot follow anybody to another site,
 * which is what the Privacy Policy promises. Only those three layouts mount
 * it (a test holds it there), so nothing inside a workspace is counted; and
 * they mount it only on Vercel, since a desktop install has nowhere to send
 * it. Each address is cleaned first (see visit-url.ts).
 */
export function SiteAnalytics() {
  return <Analytics beforeSend={(event) => ({ ...event, url: cleanVisitUrl(event.url) })} />;
}
