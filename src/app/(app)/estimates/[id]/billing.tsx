"use client";

import Link from "next/link";
import { useActionState, useState } from "react";

import { billEstimate } from "../actions";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/form";
import { ActionStatus, SubmitButton } from "@/components/ui/submit";
import { IDLE, type ActionState } from "@/lib/action-state";
import { formatMoney } from "@/lib/money";

export type BillingView = {
  totalCents: number;
  depositCents: number;
  billedCents: number;
  remainingCents: number;
  hasDeposit: boolean;
  hasFinal: boolean;
  stages: { id: string; number: string; stage: string; status: string; totalCents: number }[];
};

const STAGE_LABELS: Record<string, string> = {
  DEPOSIT: "Deposit",
  PROGRESS: "Progress",
  FINAL: "Final",
};

/**
 * Billing an accepted estimate in parts: the deposit it asked for, shares
 * as the work goes, and the final invoice for whatever is left. Each makes a
 * draft invoice and opens it, ready to look over and send.
 */
export function EstimateBilling({
  estimateId,
  billing,
  currency,
  locale,
  canBill,
}: {
  estimateId: string;
  billing: BillingView;
  currency: string;
  locale: string;
  canBill: boolean;
}) {
  const money = (cents: number) => formatMoney(cents, currency, locale);
  const [state, action] = useActionState<ActionState, FormData>(billEstimate, IDLE);
  const [mode, setMode] = useState<"PERCENT" | "AMOUNT">("PERCENT");

  const open = canBill && !billing.hasFinal && billing.remainingCents > 0;

  return (
    <Card>
      <CardHeader
        title="Billing"
        description="Bill the deposit, part of the work as it goes, then the rest."
      />
      <dl className="divide-y divide-line text-sm">
        <Row label="Estimate total">{money(billing.totalCents)}</Row>
        {billing.depositCents > 0 ? <Row label="Deposit asked">{money(billing.depositCents)}</Row> : null}
        <Row label="Billed so far">{money(billing.billedCents)}</Row>
        <Row label="Left to bill">{money(billing.remainingCents)}</Row>
      </dl>

      {billing.stages.length > 0 ? (
        <ul className="divide-y divide-line border-t border-line text-sm">
          {billing.stages.map((stage) => (
            <li key={stage.id} className="flex items-center justify-between gap-3 px-5 py-2.5">
              <span className="min-w-0">
                <span className="text-ink-muted">{STAGE_LABELS[stage.stage] ?? stage.stage} · </span>
                <Link href={`/invoices/${stage.id}`} className="font-medium text-ink hover:text-brand">
                  {stage.number}
                </Link>
                <span className="text-xs text-ink-subtle">
                  {" "}
                  · {stage.status === "CANCELLED" ? "cancelled" : stage.status.toLowerCase().replace("_", " ")}
                </span>
              </span>
              <span className="tabular text-ink">{money(stage.totalCents)}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {open ? (
        <CardBody className="space-y-4 border-t border-line">
          {billing.depositCents > 0 && !billing.hasDeposit ? (
            <form action={action}>
              <input type="hidden" name="id" value={estimateId} />
              <input type="hidden" name="stage" value="DEPOSIT" />
              <SubmitButton variant="outline" size="sm" pendingLabel="Making it…">
                Bill the deposit ({money(billing.depositCents)})
              </SubmitButton>
            </form>
          ) : null}

          <form action={action} className="space-y-2">
            <input type="hidden" name="id" value={estimateId} />
            <input type="hidden" name="stage" value="PROGRESS" />
            <input type="hidden" name="mode" value={mode} />
            <p className="text-xs font-medium text-ink-muted">Bill part of it</p>
            <div className="flex flex-wrap items-center gap-2">
              <Select
                value={mode}
                onChange={(e) => setMode(e.target.value as "PERCENT" | "AMOUNT")}
                aria-label="Bill by"
                className="h-8 w-28 text-xs"
              >
                <option value="PERCENT">Percent</option>
                <option value="AMOUNT">Amount</option>
              </Select>
              <Input
                name="value"
                inputMode="decimal"
                aria-label={mode === "PERCENT" ? "Percent to bill" : "Amount to bill"}
                placeholder={mode === "PERCENT" ? "40" : "1000.00"}
                className="tabular h-8 w-24 text-right text-xs"
              />
              <SubmitButton variant="outline" size="sm" pendingLabel="Making it…">
                Bill this part
              </SubmitButton>
            </div>
          </form>

          <form action={action}>
            <input type="hidden" name="id" value={estimateId} />
            <input type="hidden" name="stage" value="FINAL" />
            <SubmitButton size="sm" pendingLabel="Making it…">
              Final invoice ({money(billing.remainingCents)} left)
            </SubmitButton>
          </form>

          <ActionStatus state={state} />
        </CardBody>
      ) : billing.hasFinal ? (
        <CardBody className="border-t border-line">
          <p className="text-sm text-ink-muted">Billed in full — the final invoice is made.</p>
        </CardBody>
      ) : null}
    </Card>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 px-5 py-2.5">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="tabular text-right font-medium text-ink">{children}</dd>
    </div>
  );
}
