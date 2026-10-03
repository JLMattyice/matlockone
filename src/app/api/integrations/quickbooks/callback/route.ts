import { NextResponse } from "next/server";

import { requirePermission } from "@/lib/auth";
import { QuickBooksError, quickbooksRequest } from "@/lib/quickbooks/api";
import { loadConnection, saveConnection, setCompanyName } from "@/lib/quickbooks/connection";
import { exchangeCode, QuickBooksAuthError, verifyState } from "@/lib/quickbooks/oauth";
import { quickbooksSettings } from "@/lib/quickbooks/settings";

/**
 * Where Intuit sends the owner back, with a one-time code, the company's id
 * (realmId) and the state handed out by the connect route.
 *
 * The state has to name this business and this person, signed and in date:
 * otherwise anybody could send a signed-in owner here with their own code
 * and have the owner's business start writing to a stranger's books.
 *
 * Nothing is sent from here. The settings page explains the overwrite switch
 * first, and sending starts when the owner presses Send now.
 */
export async function GET(request: Request) {
  const { user, org } = await requirePermission("settings:write");
  const url = new URL(request.url);
  const back = (query: string) =>
    NextResponse.redirect(new URL(`/settings/quickbooks?${query}`, request.url));

  if (org.isDemo) return back("problem=unavailable");

  const settings = quickbooksSettings();
  if (!settings) return back("problem=unavailable");

  if (!verifyState(url.searchParams.get("state"), org.id, user.id)) {
    return back("problem=expired");
  }

  // The owner pressed Cancel at Intuit, or Intuit refused.
  if (url.searchParams.get("error")) return back("problem=declined");

  const code = url.searchParams.get("code");
  const realmId = url.searchParams.get("realmId");
  if (!code || !realmId) return back("problem=declined");

  try {
    const tokens = await exchangeCode(settings, code);

    // Saved before the company's name is asked for, so the request below
    // can use the stored connection like every other one does.
    await saveConnection({
      organizationId: org.id,
      userId: user.id,
      realmId,
      companyName: "",
      environment: settings.environment,
      tokens,
      timeZone: org.timeZone,
    });

    const connection = await loadConnection(org.id);
    if (connection) {
      try {
        const info = await quickbooksRequest<{
          CompanyInfo?: { CompanyName?: string; Country?: string };
        }>(connection, "GET", `companyinfo/${encodeURIComponent(realmId)}`);
        await setCompanyName(
          org.id,
          info.CompanyInfo?.CompanyName?.trim() ?? "",
          info.CompanyInfo?.Country?.trim() || null,
        );
      } catch (error) {
        // A name is a nicety; the connection works without one.
        if (!(error instanceof QuickBooksError)) throw error;
      }
    }
  } catch (error) {
    if (error instanceof QuickBooksAuthError) return back("problem=refused");
    throw error;
  }

  return back("connected=1");
}
