"use client";

import { useEffect, useRef } from "react";

import { markInvoiceViewed } from "./actions";

/**
 * Records the first open from the browser, not from the request — mail
 * gateways fetch links before anyone reads them, so a server-side mark would
 * report every invoice as read the moment it was delivered.
 */
export function MarkViewed({ token }: { token: string }) {
  const fired = useRef(false);

  useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    void markInvoiceViewed(token);
  }, [token]);

  return null;
}
