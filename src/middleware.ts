import { NextResponse, type NextRequest } from "next/server";

import { SESSION_COOKIE } from "@/lib/session-cookie";

/**
 * Edge-side gate. It only checks whether a session cookie is *present* — the
 * cookie is never trusted as proof of identity. Real validation happens in
 * `requireContext()` on the server, which looks the session up in the database.
 * This exists so signed-out visitors get a fast redirect instead of a flash of
 * app chrome.
 */

const PUBLIC_PREFIXES = ["/login", "/signup", "/share", "/session-expired"];

/**
 * Marketing routes, matched exactly rather than by prefix. "/" cannot go in
 * PUBLIC_PREFIXES: every path starts with it, so it would make the whole
 * application public. Each new marketing page is listed here by hand, which is
 * the point — opening a route to the world stays a deliberate edit.
 */
const PUBLIC_PAGES = new Set(["/", "/checkout/thanks"]);

export function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const hasCookie = request.cookies.has(SESSION_COOKIE);
  const isPublic =
    PUBLIC_PAGES.has(pathname) ||
    PUBLIC_PREFIXES.some(
      (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
    );

  if (!hasCookie && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = pathname === "/" ? "" : `?next=${encodeURIComponent(pathname + search)}`;
    return NextResponse.redirect(url);
  }

  if (hasCookie && (pathname === "/login" || pathname === "/signup")) {
    const url = request.nextUrl.clone();
    url.pathname = "/dashboard";
    url.search = "";
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    // Everything except Next internals, the API surface, and static files.
    "/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
