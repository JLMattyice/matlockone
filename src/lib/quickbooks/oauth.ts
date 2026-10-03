import "server-only";

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { QUICKBOOKS_SCOPE, type QuickBooksSettings } from "./settings";

/**
 * Intuit's OAuth 2.0 handshake: asking the owner, trading the answer for
 * tokens, keeping them fresh, and handing them back on disconnect.
 *
 * The access token lasts an hour and the refresh token about a hundred days,
 * renewed each time it is used — so a business that sends something at
 * least every few months never has to connect again. Intuit may hand back a
 * new refresh token on any refresh, and only the newest is good, which is
 * why every refresh is stored straight away.
 */

export type TokenSet = {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds. */
  accessExpiresAt: number;
  refreshExpiresAt: number;
};

/** Intuit refused the tokens themselves: the owner has to connect again. */
export class QuickBooksAuthError extends Error {
  constructor(
    message: string,
    readonly reconnect: boolean,
  ) {
    super(message);
    this.name = "QuickBooksAuthError";
  }
}

// -------------------------------------------------------------- the state ---

/** How long the owner has at Intuit's consent screen before the link goes stale. */
const STATE_LIFETIME_MS = 15 * 60 * 1000;

function stateKey() {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error("SESSION_SECRET must be set to at least 16 characters. See .env.example.");
  }
  return createHmac("sha256", secret).update("matlock-one:quickbooks-state:v1").digest();
}

type StatePayload = { o: string; u: string; e: number; n: string };

/**
 * The round-trip value Intuit hands back untouched. Signed, and naming the
 * business and the person who asked, so a callback cannot be replayed into
 * somebody else's session or forged to attach a stranger's QuickBooks.
 */
export function signState(organizationId: string, userId: string, now = Date.now()): string {
  const payload: StatePayload = {
    o: organizationId,
    u: userId,
    e: now + STATE_LIFETIME_MS,
    n: randomBytes(8).toString("base64url"),
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = createHmac("sha256", stateKey()).update(body).digest("base64url");
  return `${body}.${mac}`;
}

/** True only for a state this deployment signed, for this person, still in date. */
export function verifyState(
  state: string | null | undefined,
  organizationId: string,
  userId: string,
  now = Date.now(),
): boolean {
  if (!state) return false;
  const [body, mac] = state.split(".");
  if (!body || !mac) return false;

  const expected = Buffer.from(createHmac("sha256", stateKey()).update(body).digest("base64url"));
  const given = Buffer.from(mac);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;

  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as StatePayload;
    return payload.o === organizationId && payload.u === userId && payload.e > now;
  } catch {
    return false;
  }
}

/** Intuit's consent screen, for the owner to choose a company and agree. */
export function authorizeUrl(settings: QuickBooksSettings, state: string): string {
  const url = new URL(settings.authorizeUrl);
  url.searchParams.set("client_id", settings.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", QUICKBOOKS_SCOPE);
  url.searchParams.set("redirect_uri", settings.redirectUri);
  url.searchParams.set("state", state);
  return url.toString();
}

// ------------------------------------------------------------- the tokens ---

function basicAuth(settings: QuickBooksSettings) {
  return `Basic ${Buffer.from(`${settings.clientId}:${settings.clientSecret}`).toString("base64")}`;
}

async function tokenRequest(
  settings: QuickBooksSettings,
  body: Record<string, string>,
  now: number,
): Promise<TokenSet> {
  let response: Response;
  try {
    response = await fetch(settings.tokenUrl, {
      method: "POST",
      headers: {
        Authorization: basicAuth(settings),
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(body),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new QuickBooksAuthError("QuickBooks could not be reached. Try again in a minute.", false);
  }

  const json = (await response.json().catch(() => null)) as Record<string, unknown> | null;

  if (!response.ok || !json || typeof json.access_token !== "string") {
    const code = typeof json?.error === "string" ? json.error : "";
    // invalid_grant: the refresh token is spent, revoked or past its hundred
    // days — nothing but the owner connecting again will fix it.
    if (code === "invalid_grant") {
      throw new QuickBooksAuthError("QuickBooks needs connecting again.", true);
    }
    if (code === "invalid_client") {
      throw new QuickBooksAuthError(
        "QuickBooks did not accept this deployment's app keys. Check QUICKBOOKS_CLIENT_ID and QUICKBOOKS_CLIENT_SECRET.",
        false,
      );
    }
    throw new QuickBooksAuthError(
      `QuickBooks refused the sign-in (${response.status}${code ? `, ${code}` : ""}).`,
      false,
    );
  }

  const seconds = (value: unknown, fallback: number) =>
    typeof value === "number" && Number.isFinite(value) ? value : fallback;

  return {
    accessToken: json.access_token,
    refreshToken: typeof json.refresh_token === "string" ? json.refresh_token : "",
    accessExpiresAt: now + seconds(json.expires_in, 3600) * 1000,
    refreshExpiresAt: now + seconds(json.x_refresh_token_expires_in, 100 * 86_400) * 1000,
  };
}

/** The owner said yes: trade the one-time code for tokens. */
export function exchangeCode(settings: QuickBooksSettings, code: string, now = Date.now()) {
  return tokenRequest(
    settings,
    { grant_type: "authorization_code", code, redirect_uri: settings.redirectUri },
    now,
  );
}

/** A fresh access token, and whatever refresh token Intuit wants kept now. */
export async function refreshTokens(
  settings: QuickBooksSettings,
  tokens: TokenSet,
  now = Date.now(),
): Promise<TokenSet> {
  const fresh = await tokenRequest(
    settings,
    { grant_type: "refresh_token", refresh_token: tokens.refreshToken },
    now,
  );
  // Intuit sends the refresh token every time, but keep the old one if a
  // response ever leaves it out rather than storing an empty string.
  return { ...fresh, refreshToken: fresh.refreshToken || tokens.refreshToken };
}

/**
 * Hands the permission back on disconnect, so Matlock One no longer appears
 * under the company's connected apps. Best effort: a failure here must not
 * keep somebody connected who asked not to be.
 */
export async function revokeTokens(settings: QuickBooksSettings, tokens: TokenSet): Promise<boolean> {
  try {
    const response = await fetch(settings.revokeUrl, {
      method: "POST",
      headers: {
        Authorization: basicAuth(settings),
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ token: tokens.refreshToken }),
      signal: AbortSignal.timeout(10_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}
