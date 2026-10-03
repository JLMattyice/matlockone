"use client";

import { useActionState } from "react";

import {
  saveQuickBooksExpenseAccounts,
  sendToQuickBooksNow,
  setQuickBooksStartDate,
} from "./actions";
import { CardBody, CardFooter } from "@/components/ui/card";
import { Input, Label, Select } from "@/components/ui/form";
import { ActionStatus, SubmitButton } from "@/components/ui/submit";
import { IDLE, type ActionState } from "@/lib/action-state";
import { cn } from "@/lib/utils";

export function SendNow() {
  const [state, action] = useActionState<ActionState, FormData>(sendToQuickBooksNow, IDLE);

  return (
    <form action={action} className="flex flex-wrap items-center gap-3">
      <SubmitButton pendingLabel="Sending…">Send now</SubmitButton>
      <ActionStatus state={state} />
    </form>
  );
}

export function StartDateForm({ sendFrom, readOnly }: { sendFrom: string; readOnly: boolean }) {
  const [state, action] = useActionState<ActionState, FormData>(setQuickBooksStartDate, IDLE);

  return (
    <form action={action}>
      <CardBody className="space-y-2">
        <Label htmlFor="sendFrom">Send invoices and expenses dated on or after</Label>
        <Input
          id="sendFrom"
          name="sendFrom"
          type="date"
          defaultValue={sendFrom}
          disabled={readOnly}
          className="sm:w-52"
        />
      </CardBody>
      {readOnly ? null : (
        <CardFooter>
          <ActionStatus state={state} className="mr-auto" />
          <SubmitButton variant="outline">Save date</SubmitButton>
        </CardFooter>
      )}
    </form>
  );
}

export type AccountOption = { id: string; name: string; type: string };

export function ExpenseAccountsForm({
  categories,
  expenseAccounts,
  paidFromAccounts,
  chosen,
  paidFrom,
  waiting,
  readOnly,
}: {
  categories: { value: string; label: string }[];
  expenseAccounts: AccountOption[];
  paidFromAccounts: AccountOption[];
  chosen: Record<string, string>;
  paidFrom: string | null;
  /** Expenses held back per category for want of an account. */
  waiting: Record<string, number>;
  readOnly: boolean;
}) {
  const [state, action] = useActionState<ActionState, FormData>(saveQuickBooksExpenseAccounts, IDLE);

  return (
    <form action={action}>
      <CardBody className="space-y-5">
        <div className="space-y-1.5">
          <Label htmlFor="paidFrom">Paid from</Label>
          <Select
            id="paidFrom"
            name="paidFrom"
            defaultValue={paidFrom ?? ""}
            disabled={readOnly}
            className="sm:w-80"
          >
            <option value="">Choose a bank or card account…</option>
            {paidFromAccounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name} ({account.type === "Credit Card" ? "card" : "bank"})
              </option>
            ))}
          </Select>
        </div>

        <div className="divide-y divide-line rounded-lg border border-line">
          {categories.map((category) => {
            const held = waiting[category.value] ?? 0;
            return (
              <div
                key={category.value}
                className="grid grid-cols-1 gap-2 px-4 py-2.5 sm:grid-cols-[minmax(0,1fr)_18rem] sm:items-center"
              >
                <label htmlFor={`category:${category.value}`} className="text-sm text-ink">
                  {category.label}
                  {held > 0 ? (
                    <span className="ml-2 text-xs text-warning">
                      {held} waiting
                    </span>
                  ) : null}
                </label>
                <Select
                  id={`category:${category.value}`}
                  name={`category:${category.value}`}
                  defaultValue={chosen[category.value] ?? ""}
                  disabled={readOnly}
                  className={cn(!chosen[category.value] && "text-ink-subtle")}
                >
                  <option value="">Not sent</option>
                  {expenseAccounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.name}
                    </option>
                  ))}
                </Select>
              </div>
            );
          })}
        </div>
      </CardBody>
      {readOnly ? null : (
        <CardFooter>
          <ActionStatus state={state} className="mr-auto" />
          <SubmitButton>Save accounts</SubmitButton>
        </CardFooter>
      )}
    </form>
  );
}
