"use client";

import { useEffect } from "react";

/**
 * Registers /sw.js, whose only job is the "No connection" page on a phone
 * that has lost signal.
 *
 * Skipped inside the desktop app: it shows its own offline screen when a load
 * fails, and would never hear of the failure if the worker answered first.
 */
export function ServiceWorker() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    if (/\bElectron\//.test(navigator.userAgent)) return;
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // Not having the offline page is no reason to trouble anybody.
    });
  }, []);

  return null;
}
