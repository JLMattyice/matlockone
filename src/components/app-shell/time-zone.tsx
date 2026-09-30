"use client";

import { createContext, useContext, useEffect } from "react";
import { useRouter } from "next/navigation";

import { DEFAULT_TIME_ZONE, TIME_ZONE_COOKIE, usableTimeZone } from "@/lib/time-zone";

const TimeZoneContext = createContext<string>(DEFAULT_TIME_ZONE);

/** The zone the server rendered this page in, for client components to format in too. */
export function useTimeZone() {
  return useContext(TimeZoneContext);
}

/** The zones a refresh has already been asked for, so a server that cannot use one is asked once. */
const refreshedFor = new Set<string>();

/**
 * Hands the page's time zone to client components, and keeps it the zone of
 * this machine.
 *
 * `zone` is what the server rendered in. The browser writes its own zone to a
 * cookie for every later request, and when the two differ — the first page
 * after signing in, or a laptop that has crossed a time zone — asks the server
 * to render again, so nothing stays on the wrong clock past the first paint.
 */
export function TimeZoneProvider({
  zone,
  children,
}: {
  zone: string;
  children: React.ReactNode;
}) {
  const router = useRouter();

  useEffect(() => {
    let own: string | undefined;
    try {
      own = usableTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
    } catch {
      return;
    }
    if (!own) return;

    const secure = window.location.protocol === "https:" ? "; secure" : "";
    document.cookie =
      `${TIME_ZONE_COOKIE}=${own}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax${secure}`;

    // Only when the cookie took, or the refresh would render the same page again.
    const took = document.cookie
      .split("; ")
      .some((pair) => pair === `${TIME_ZONE_COOKIE}=${own}`);
    if (own !== zone && took && !refreshedFor.has(own)) {
      refreshedFor.add(own);
      router.refresh();
    }
  }, [zone, router]);

  return <TimeZoneContext.Provider value={zone}>{children}</TimeZoneContext.Provider>;
}
