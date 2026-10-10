import { Ticket } from "lucide-react";

import { setTrialCodeOn } from "./actions";
import type { TrialCodeRow } from "./queries";
import { CopyLink, NewTrialCodeForm } from "./trial-code-form";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/page-header";
import { SubmitButton } from "@/components/ui/submit";
import { Table, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import { TRIAL_CODE_STATE_META, trialCodeState, usesLabel } from "@/lib/billing/trial-codes";

/**
 * Free-month codes on the Accounts page: making them, seeing who used each,
 * and switching one off.
 */
export function TrialCodesCard({
  codes,
  ready,
  appUrl,
  today,
  day,
  now,
}: {
  codes: TrialCodeRow[];
  /** Whether PayPal has the free-month plans, without which a code does nothing. */
  ready: boolean;
  appUrl: string;
  /** "YYYY-MM-DD" on the operator's clock, the earliest last day a code can have. */
  today: string;
  day: (date: Date) => string;
  now: Date;
}) {
  return (
    <Card id="codes">
      <CardHeader
        title="Free-month codes"
        description="Give someone a code and their first month on a monthly plan is free. They still approve the plan in PayPal, which takes the first payment a month later unless they cancel."
      />

      <CardBody className="space-y-4">
        {ready ? null : (
          <p className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-ink" role="status">
            PayPal doesn’t have the free-month plans yet, so codes don’t do anything for now. Run{" "}
            <code className="font-mono text-xs">npm run paypal:setup</code>, put the three{" "}
            <code className="font-mono text-xs">PAYPAL_PLAN_…_MONTHLY_TRIAL</code> lines it prints into
            Vercel, and redeploy.
          </p>
        )}
        <NewTrialCodeForm today={today} />
      </CardBody>

      {codes.length === 0 ? (
        <EmptyState
          icon={<Ticket className="h-5 w-5" strokeWidth={1.75} />}
          title="No codes yet"
          description="Codes you make show here, with the businesses that used each one."
        />
      ) : (
        <Table>
          <THead>
            <Th>Code</Th>
            <Th className="hidden md:table-cell">Who it’s for</Th>
            <Th>Used</Th>
            <Th className="hidden sm:table-cell">Ends</Th>
            <Th>Status</Th>
            <Th align="right">
              <span className="sr-only">Turn on or off</span>
            </Th>
          </THead>
          <TBody>
            {codes.map((code) => {
              const uses = code.organizations.length;
              const meta = TRIAL_CODE_STATE_META[trialCodeState(code, uses, now)];
              const shown = code.organizations.slice(0, 3).map((org) => org.name);
              const more = uses - shown.length;

              return (
                <Tr key={code.id}>
                  <Td>
                    <span className="block font-mono font-medium">{code.code}</span>
                    <CopyLink url={`${appUrl}/signup?code=${encodeURIComponent(code.code)}`} />
                    {code.note ? (
                      <span className="block text-xs text-ink-muted md:hidden">{code.note}</span>
                    ) : null}
                  </Td>
                  <Td className="hidden text-ink-muted md:table-cell">{code.note ?? "—"}</Td>
                  <Td>
                    <span className="tabular block">{usesLabel(uses, code.maxUses)}</span>
                    {shown.length ? (
                      <span className="block text-xs text-ink-subtle">
                        {shown.join(", ")}
                        {more > 0 ? ` and ${more} more` : null}
                      </span>
                    ) : null}
                  </Td>
                  <Td className="tabular hidden whitespace-nowrap text-ink-muted sm:table-cell">
                    {/* Kept as the moment it stops, shown as the last day it works. */}
                    {code.expiresAt ? `Through ${day(new Date(code.expiresAt.getTime() - 1))}` : "No end"}
                  </Td>
                  <Td>
                    <Badge tone={meta.tone} dot>
                      {meta.label}
                    </Badge>
                  </Td>
                  <Td align="right">
                    <form action={setTrialCodeOn}>
                      <input type="hidden" name="id" value={code.id} />
                      <input type="hidden" name="on" value={code.disabledAt ? "true" : "false"} />
                      <SubmitButton variant="ghost" size="sm" pendingLabel="…">
                        {code.disabledAt ? "Turn on" : "Turn off"}
                      </SubmitButton>
                    </form>
                  </Td>
                </Tr>
              );
            })}
          </TBody>
        </Table>
      )}
    </Card>
  );
}
