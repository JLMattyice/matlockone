"use client";

import { useState } from "react";

import { setJobStatus } from "../actions";
import { Button, buttonClasses } from "@/components/ui/button";
import { Input } from "@/components/ui/form";

/**
 * Cancelling asks why. The reason ends up on the job and in reporting, so it is
 * worth one extra interaction rather than a bare button.
 */
export function CancelJob({ jobId }: { jobId: string }) {
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={buttonClasses("ghost", "sm")}
      >
        Cancel
      </button>
    );
  }

  return (
    <form action={setJobStatus} className="flex items-center gap-2">
      <input type="hidden" name="id" value={jobId} />
      <input type="hidden" name="status" value="CANCELLED" />
      <Input
        name="cancelReason"
        placeholder="Reason (optional)"
        aria-label="Cancellation reason"
        autoFocus
        className="h-8 w-48 text-xs"
      />
      <Button type="submit" variant="danger" size="sm">
        Confirm
      </Button>
      <button
        type="button"
        onClick={() => setOpen(false)}
        className={buttonClasses("ghost", "sm")}
      >
        Keep
      </button>
    </form>
  );
}
