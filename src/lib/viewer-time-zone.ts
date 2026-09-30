import "server-only";

import { cache } from "react";
import { cookies } from "next/headers";

import { getContext } from "./auth";
import { DEFAULT_TIME_ZONE, TIME_ZONE_COOKIE, usableTimeZone } from "./time-zone";

/**
 * The time zone of the machine this request came from, resolved once per
 * request.
 *
 * The browser writes it to a cookie (see <TimeZoneProvider>). Until it has —
 * the very first page after signing in, or a browser refusing cookies — the
 * business's own zone from Settings stands in, which is right for everyone
 * working where the business is.
 */
export const viewerTimeZone = cache(async (): Promise<string> => {
  const jar = await cookies();
  const own = usableTimeZone(jar.get(TIME_ZONE_COOKIE)?.value);
  if (own) return own;

  const ctx = await getContext();
  return usableTimeZone(ctx?.org.timeZone) ?? DEFAULT_TIME_ZONE;
});
