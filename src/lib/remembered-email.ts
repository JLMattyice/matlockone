import "server-only";

import { cookies } from "next/headers";

/**
 * The email address last used to sign in on this computer.
 *
 * Only the address, never the password. It exists so the sign-in screen opens
 * with the field already filled and the cursor in the password box, which is
 * the whole of what most people mean by "autofill" on a machine they own.
 *
 * Stored in an httpOnly cookie rather than localStorage so the login page can
 * render it on the server. That avoids the field flashing empty on first paint,
 * and keeps it out of reach of any script running on the page.
 *
 * It is written only when "keep me signed in" was ticked, and cleared when it
 * was not: someone who says this is not their computer should not have their
 * address left on its sign-in screen.
 */
const REMEMBERED_EMAIL_COOKIE = "fb_last_email";

/** Chrome caps persistent cookies at 400 days and silently trims longer ones. */
const COOKIE_DAYS = 400;

/** RFC 5321's limit on an address. Anything longer is not one. */
const MAX_EMAIL = 254;

export async function readRememberedEmail(): Promise<string> {
  const store = await cookies();
  const value = store.get(REMEMBERED_EMAIL_COOKIE)?.value ?? "";
  return value.length > MAX_EMAIL ? "" : value;
}

export async function rememberEmail(email: string) {
  const store = await cookies();
  store.set(REMEMBERED_EMAIL_COOKIE, email.trim().toLowerCase().slice(0, MAX_EMAIL), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: new Date(Date.now() + COOKIE_DAYS * 24 * 60 * 60 * 1000),
  });
}

export async function forgetRememberedEmail() {
  const store = await cookies();
  store.delete(REMEMBERED_EMAIL_COOKIE);
}
