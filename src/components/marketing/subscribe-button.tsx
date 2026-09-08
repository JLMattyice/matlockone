"use client";

import * as React from "react";

import { buttonClasses } from "@/components/ui/button";
import type { LicensePlan } from "@/lib/license/token";

/**
 * Sends a buyer to PayPal.
 *
 * The plan is a name, not a price. The server looks it up against the billing
 * plan configured for it, so nothing this component sends can change what is
 * charged.
 */
export function SubscribeButton({
  plan,
  featured,
  label,
}: {
  plan: LicensePlan;
  featured: boolean;
  label: string;
}) {
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function subscribe() {
    setPending(true);
    setError(null);

    try {
      const response = await fetch("/api/checkout/paypal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan, interval: "annual" }),
      });

      const body = (await response.json()) as {
        approveUrl?: string;
        error?: string;
      };

      if (!response.ok || !body.approveUrl) {
        setError(body.error ?? "Could not start checkout. Please try again.");
        setPending(false);
        return;
      }

      // Deliberately not resetting `pending`: the navigation is the end of this
      // component's life, and a button that springs back to "Subscribe" while
      // the browser is still leaving invites a second click and a second
      // subscription.
      window.location.href = body.approveUrl;
    } catch {
      setError("Could not reach the checkout. Please try again.");
      setPending(false);
    }
  }

  return (
    <div className="mt-8">
      <button
        type="button"
        onClick={subscribe}
        disabled={pending}
        className={buttonClasses(
          featured ? "primary" : "outline",
          "md",
          "w-full justify-center",
        )}
      >
        {pending ? "Taking you to PayPal…" : label}
      </button>

      {error ? (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
