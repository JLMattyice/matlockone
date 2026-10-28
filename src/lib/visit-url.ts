/**
 * What a counted visit's address may carry to Vercel Web Analytics (see
 * components/site-analytics.tsx).
 *
 * The path, and the utm_ tags that say which link or campaign sent somebody —
 * nothing else. A query string can hold a free-month code or a sign-in's
 * ?next= path, so it goes; a password-reset link's path holds the token that
 * resets the password, so that goes too.
 *
 * Pure, so it is tested without a browser.
 */
export function cleanVisitUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw.split(/[?#]/)[0];
  }

  const kept = new URLSearchParams();
  for (const [key, value] of url.searchParams) {
    if (key.toLowerCase().startsWith("utm_")) kept.append(key, value);
  }

  const path = url.pathname.replace(/^\/reset-password\/[^/]+/, "/reset-password/[token]");
  const query = kept.toString();
  return `${url.origin}${path}${query ? `?${query}` : ""}`;
}
