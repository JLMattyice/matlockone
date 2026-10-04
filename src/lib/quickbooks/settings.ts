import "server-only";

import { resolveAppUrl, type ConfigEnv } from "../config";

/**
 * How this deployment reaches QuickBooks Online.
 *
 * There is one Intuit app for every business on the deployment — Matlock
 * Software's — and each business connects its own QuickBooks company to it.
 * So the client id and secret are the deployment's, set in its environment,
 * and what a business stores is only the permission its owner granted.
 *
 * Sandbox unless told otherwise: Intuit's development keys only reach test
 * companies, and pointing them at production fails confusingly rather than
 * safely. QUICKBOOKS_ENVIRONMENT=production goes in once Intuit has issued
 * production keys.
 */

export type QuickBooksEnvironment = "sandbox" | "production";

export type QuickBooksSettings = {
  clientId: string;
  clientSecret: string;
  environment: QuickBooksEnvironment;
  /** Where Intuit sends the owner back. Must be listed on the Intuit app exactly. */
  redirectUri: string;
  /**
   * Intuit's discovery document, which names the three OAuth endpoints below.
   * They are read from it (see discovery.ts); the values here are what it
   * said when this was written, used only when it cannot be reached. Null
   * when the endpoints are overridden, so the test suite's stand-in is used.
   */
  discoveryUrl: string | null;
  authorizeUrl: string;
  tokenUrl: string;
  revokeUrl: string;
  /** The accounting API, without the /v3/company/… part. */
  apiBase: string;
};

/** Intuit's accounting permission — the only one asked for. */
export const QUICKBOOKS_SCOPE = "com.intuit.quickbooks.accounting";

/** The API version each request asks for, so a change on Intuit's side is opted into. */
export const QUICKBOOKS_MINOR_VERSION = "75";

/** Null when the deployment has no Intuit app configured. */
export function quickbooksSettings(env: ConfigEnv = process.env): QuickBooksSettings | null {
  const clientId = env.QUICKBOOKS_CLIENT_ID?.trim();
  const clientSecret = env.QUICKBOOKS_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;

  const environment: QuickBooksEnvironment =
    env.QUICKBOOKS_ENVIRONMENT?.trim().toLowerCase() === "production" ? "production" : "sandbox";

  // The overrides exist for the test suite's stand-in for Intuit, which runs
  // on a local port. Nothing in production sets them.
  const oauthBase = env.QUICKBOOKS_OAUTH_BASE?.trim().replace(/\/$/, "");
  const apiOverride = env.QUICKBOOKS_API_BASE?.trim().replace(/\/$/, "");

  return {
    clientId,
    clientSecret,
    environment,
    redirectUri: `${resolveAppUrl(env)}/api/integrations/quickbooks/callback`,
    discoveryUrl: oauthBase
      ? null
      : environment === "production"
        ? "https://developer.api.intuit.com/.well-known/openid_configuration"
        : "https://developer.api.intuit.com/.well-known/openid_sandbox_configuration",
    authorizeUrl: "https://appcenter.intuit.com/connect/oauth2",
    tokenUrl: `${oauthBase ?? "https://oauth.platform.intuit.com"}/oauth2/v1/tokens/bearer`,
    revokeUrl: `${oauthBase ?? "https://developer.api.intuit.com"}/v2/oauth2/tokens/revoke`,
    apiBase:
      apiOverride ??
      (environment === "production"
        ? "https://quickbooks.api.intuit.com"
        : "https://sandbox-quickbooks.api.intuit.com"),
  };
}
