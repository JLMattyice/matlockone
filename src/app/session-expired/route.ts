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
  const next = request.nextUrl.searchParams.get("next");

  // A relative Location, so the browser resolves it against the address it
  // actually used. request.nextUrl names the server's own host — localhost on
  // a desktop install — and a phone reaching that install over the office
  // network would be sent to "localhost", which on a phone is the phone.
  const response = new NextResponse(null, {
    status: 307,
    headers: { Location: `/login${next ? `?next=${encodeURIComponent(next)}` : ""}` },
  });
  response.cookies.delete(SESSION_COOKIE);
  return response;
}
