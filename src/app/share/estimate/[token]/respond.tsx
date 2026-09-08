"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, X } from "lucide-react";

import { markEstimateViewed, respondToEstimate } from "./actions";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/form";

/**
 * Records the first open from the browser rather than during render.
 *
 * Corporate mail gateways and link scanners fetch URLs before a person ever
 * sees them; marking "viewed" server-side on request would report every
 * estimate as read the moment it was delivered. Requiring the page to actually
 * run in a browser makes the signal mean something.
 */
export function MarkViewed({ token }: { token: string }) {
  const fired = useRef(false);

  useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    void markEstimateViewed(token);
  }, [token]);

  return null;
}

export function RespondPanel({
  token,
  brandColor,
}: {
  token: string;
  brandColor: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [mode, setMode] = useState<"idle" | "declining">("idle");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  function respond(decision: "ACCEPTED" | "DECLINED") {
    setError(null);
    startTransition(async () => {
      const result = await respondToEstimate(token, decision, reason);
      if (!result.ok) {
        setError(result.error ?? "Something went wrong.");
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="rounded-card border border-line bg-surface p-5">
      <h2 className="text-base font-semibold text-ink">
        Ready to go ahead?
      </h2>
      <p className="mt-1 text-sm text-ink-muted">
        Accepting lets us book the work in. You can still call us with questions.
      </p>

      {error ? (
        <p role="alert" className="mt-3 text-sm text-danger">
          {error}
        </p>
      ) : null}

      {mode === "declining" ? (
        <div className="mt-4 space-y-3">
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            placeholder="Anything you'd like us to know? (optional)"
            aria-label="Reason for declining"
          />
          <div className="flex flex-wrap gap-2">
            <Button
              variant="danger"
              onClick={() => respond("DECLINED")}
              disabled={pending}
            >
              {pending ? "Sending…" : "Confirm decline"}
            </Button>
            <Button
              variant="ghost"
              onClick={() => setMode("idle")}
              disabled={pending}
            >
              Back
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => respond("ACCEPTED")}
            disabled={pending}
            style={{ backgroundColor: brandColor }}
            className="inline-flex h-11 items-center gap-2 rounded-lg px-5 text-sm font-medium text-white shadow-sm transition-[filter] hover:brightness-110 disabled:opacity-60"
          >
            <Check className="h-4 w-4" strokeWidth={2.5} />
            {pending ? "Sending…" : "Accept this estimate"}
          </button>

          <Button
            variant="outline"
            size="lg"
            onClick={() => setMode("declining")}
            disabled={pending}
          >
            <X className="h-4 w-4" strokeWidth={2} />
            Decline
          </Button>
        </div>
      )}
    </div>
  );
}
