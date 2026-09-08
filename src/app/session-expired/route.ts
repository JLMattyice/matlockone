import { NextResponse, type NextRequest } from "next/server";

import { SESSION_COOKIE } from "@/lib/session-cookie";

/**
 * Breaks the stale-cookie deadlock.
 *
 * Middleware can only see that a session cookie *exists*; it cannot check the
 * database from the Edge runtime. So a cookie whose session has expired, been
 * revoked, or belongs to a deactivated user would bounce forever: middleware
 * sends /login to /dashboard because a cookie is present, and /dashboard sends
 * the user back to /login because the session does not resolve.
 *
 * A server component cannot delete a cookie during render, but a route handler
 * can. `requireContext()` redirects here, this clears the cookie, and the
 * onward redirect to /login then sees a signed-out visitor.
 */
export async function GET(request: NextRequest) {
  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.search = request.nextUrl.searchParams.has("next")
    ? `?next=${encodeURIComponent(request.nextUrl.searchParams.get("next")!)}`
    : "";

  const response = NextResponse.redirect(url);
  response.cookies.delete(SESSION_COOKIE);
  return response;
}
