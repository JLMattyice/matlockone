"use client";

import { Printer } from "lucide-react";

import { buttonClasses } from "@/components/ui/button";

/**
 * Prints the page rather than opening a separate print route. Everything the
 * customer should not see carries `no-print`, so the browser's own print
 * pipeline produces the document — no second render path to keep in step, and
 * "Save as PDF" comes free from the print dialog.
 */
export function PrintButton({ label = "Print" }: { label?: string }) {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className={buttonClasses("outline", "md")}
    >
      <Printer className="h-3.5 w-3.5" strokeWidth={2} />
      {label}
    </button>
  );
}
