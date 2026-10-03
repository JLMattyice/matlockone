import { NextResponse } from "next/server";

import { DEMO_REFUSED_PATH, requirePermission } from "@/lib/auth";
import { authorizeUrl, signState } from "@/lib/quickbooks/oauth";
import { quickbooksSettings } from "@/lib/quickbooks/settings";
import { encryptionAvailable } from "@/lib/secret-box";

/**
 * "Connect to QuickBooks": sends the owner to Intuit to choose a company and
 * agree. Intuit sends them back to the callback beside this route.
 */
export async function GET(request: Request) {
  const { user, org } = await requirePermission("settings:write");
  const back = (problem: string) =>
    NextResponse.redirect(new URL(`/settings/quickbooks?problem=${problem}`, request.url));

  // The demo is looked at, not changed — and a real company must not end up
  // attached to the business every visitor shares.
  if (org.isDemo) return NextResponse.redirect(new URL(DEMO_REFUSED_PATH, request.url));

  // No keys, no QuickBooks. A desktop install never has them: none ship in
  // the installer, and Intuit would not send anybody back to a laptop anyway.
  const settings = quickbooksSettings();
  if (!settings) return back("unavailable");
  if (!encryptionAvailable()) return back("encryption");

  return NextResponse.redirect(authorizeUrl(settings, signState(org.id, user.id)));
}
