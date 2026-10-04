import "server-only";

import type { QuickBooksSettings } from "./settings";

/**
 * Intuit's OAuth endpoints, as its discovery document names them today.
 *
 * Intuit asks apps to read the endpoints from the document rather than
 * build them in, so a move on their side is picked up without a release.
 * The document is fetched at most once a day per server, and a failure to
 * reach it falls back to the endpoints in settings.ts — a sign-in should not
 * fail because a lookup about where to sign in did.
 */

export type OAuthEndpoints = Pick<QuickBooksSettings, "authorizeUrl" | "tokenUrl" | "revokeUrl">;

const CACHE_MS = 24 * 60 * 60 * 1000;

const cache = new Map<string, { endpoints: OAuthEndpoints; until: number }>();

function fallback(settings: QuickBooksSettings): OAuthEndpoints {
  return {
    authorizeUrl: settings.authorizeUrl,
    tokenUrl: settings.tokenUrl,
    revokeUrl: settings.revokeUrl,
  };
}

/** Only an https address on one of Intuit's own domains is taken from the document. */
function intuitUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.endsWith(".intuit.com") ? value : null;
  } catch {
    return null;
  }
}

export async function oauthEndpoints(
  settings: QuickBooksSettings,
  now = Date.now(),
): Promise<OAuthEndpoints> {
  const source = settings.discoveryUrl;
  if (!source) return fallback(settings);

  const cached = cache.get(source);
  if (cached && cached.until > now) return cached.endpoints;

  try {
    const response = await fetch(source, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return fallback(settings);
    const json = (await response.json()) as Record<string, unknown>;

    const authorizeUrl = intuitUrl(json.authorization_endpoint);
    const tokenUrl = intuitUrl(json.token_endpoint);
    const revokeUrl = intuitUrl(json.revocation_endpoint);
    if (!authorizeUrl || !tokenUrl || !revokeUrl) return fallback(settings);

    const endpoints = { authorizeUrl, tokenUrl, revokeUrl };
    cache.set(source, { endpoints, until: now + CACHE_MS });
    return endpoints;
  } catch {
    return fallback(settings);
  }
}

/** For tests: forget what the document said. */
export function forgetDiscovery() {
  cache.clear();
}
