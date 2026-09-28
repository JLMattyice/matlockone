import "server-only";

import { headers } from "next/headers";

/**
 * Whether this request comes from a phone, as far as a server can tell before
 * anything has been drawn.
 *
 * "Mobi" in the user agent is the convention phone browsers follow; tablets
 * leave it out, and get the default a wider screen suits. Only ever used to
 * choose where something starts — whatever a person picks wins over it.
 */
export async function isPhone(): Promise<boolean> {
  try {
    return /Mobi/i.test((await headers()).get("user-agent") ?? "");
  } catch {
    // Outside a request there is no device to ask about.
    return false;
  }
}
