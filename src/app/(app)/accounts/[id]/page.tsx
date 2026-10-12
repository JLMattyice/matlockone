import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Ban, Trash2 } from "lucide-react";

import { liftBanAction } from "../actions";
import { businessDetail } from "../queries";
import { BanForm, DeleteForm } from "./ban-forms";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { SubmitButton } from "@/components/ui/submit";
import { Table, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import { planLabel, STANDING_META, standingOf } from "@/lib/accounts-overview";
import { CANCELLABLE } from "@/lib/billing/subscription";
import { asStatus, ROLE_META, ROLES, type Role } from "@/lib/constants";
import { requireOperator } from "@/lib/operator";
import { formatIn } from "@/lib/time-zone";
import { viewerTimeZone } from "@/lib/viewer-time-zone";

export const metadata: Metadata = { title: "Business" };

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * One business, from the operator's Accounts page: who is in it, where it
 * stands, and the two things only the operator can do to it — ban it for
 * breaking the terms, or delete it for good.
 */
export default async function BusinessPage({ params }: { params: Promise<{ id: string }> }) {
  const { org: own } = await requireOperator();
  const { id } = await params;

  const [business, zone] = await Promise.all([businessDetail(id), viewerTimeZone()]);
  if (!business) notFound();

  const now = new Date();
  const standing = STANDING_META[standingOf(business, now)];
  const isOwn = business.id === own.id;
  // Banning cancels the plan; one still live means PayPal said no.
  const stillCharging =
    business.bannedAt !== null &&
    business.subscriptionId !== null &&
    CANCELLABLE.has(business.subscriptionStatus ?? "");
  const day = (date: Date) => formatIn(date, "MMM d, yyyy", zone);
  const lastSeen = (date: Date | null) => (date ? formatIn(date, "MMM d, h:mm a", zone) : "Never");
  const counts = business._count;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <Link
          href="/accounts"
          className="mb-3 inline-flex items-center gap-1.5 text-sm text-ink-muted transition-colors hover:text-ink"
        >
          <ArrowLeft className="h-4 w-4" strokeWidth={1.75} />
          Accounts
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight text-ink">{business.name}</h1>
          <span title={standing.hint}>
            <Badge tone={standing.tone} dot>
              {standing.label}
            </Badge>
          </span>
        </div>
        <p className="mt-1 text-sm text-ink-muted">
          Signed up {day(business.createdAt)}
          {planLabel(business) ? ` · ${planLabel(business)}` : null}
          {business.paidThrough ? ` · paid through ${day(business.paidThrough)}` : null}
          {[
            "",
            count(counts.clients, "client", "clients"),
            count(counts.jobs, "job", "jobs"),
            count(counts.invoices, "invoice", "invoices"),
            count(counts.attachments, "file", "files"),
          ].join(" · ")}
        </p>
      </div>

      <Card>
        <CardHeader title="People" description="Everyone with a sign-in to this business." />
        <Table>
          <THead>
            <Th>Person</Th>
            <Th className="hidden sm:table-cell">Role</Th>
            <Th className="hidden md:table-cell">Joined</Th>
            <Th>Last sign-in</Th>
          </THead>
          <TBody>
            {business.users.map((person) => (
              <Tr key={person.id}>
                <Td>
                  <span className="block font-medium">
                    {person.name}
                    {person.isActive ? null : (
                      <span className="ml-1.5 text-xs font-normal text-ink-subtle">(deactivated)</span>
                    )}
                  </span>
                  <span className="block text-xs break-all text-ink-subtle">{person.email}</span>
                </Td>
                <Td className="hidden text-ink-muted sm:table-cell">
                  {ROLE_META[asStatus(ROLES, person.role, "EMPLOYEE") as Role].label}
                </Td>
                <Td className="tabular hidden whitespace-nowrap text-ink-muted md:table-cell">
                  {day(person.createdAt)}
                </Td>
                <Td className="tabular whitespace-nowrap text-ink-muted">{lastSeen(person.lastLoginAt)}</Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      </Card>

      {isOwn ? (
        <Card>
          <CardBody>
            <p className="text-sm text-ink-muted">
              This is the business you’re signed in to, so it can’t be banned or deleted from here.
            </p>
          </CardBody>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader
              title={
                <span className="inline-flex items-center gap-2">
                  <Ban className="h-4 w-4 text-danger" strokeWidth={1.75} />
                  {business.bannedAt ? "Banned" : "Ban"}
                </span>
              }
              description={
                business.bannedAt
                  ? undefined
                  : "For a business that breaks your terms. Everyone in it is signed out and can’t sign back in, its customers’ links stop working, its automations stop, and its plan with you is cancelled. Nothing is deleted, and you can lift the ban later. Its emails stay taken, so the same people can’t sign up again with them."
              }
            />
            <CardBody className="space-y-3">
              {business.bannedAt ? (
                <>
                  <p className="text-sm text-ink">
                    Banned {day(business.bannedAt)}
                    {business.banReason ? (
                      <>
                        : <span className="whitespace-pre-line">{business.banReason}</span>
                      </>
                    ) : null}
                  </p>
                  {stillCharging ? (
                    <p className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-ink">
                      PayPal didn’t cancel its plan, so it may still be charged. Cancel subscription{" "}
                      <span className="font-mono select-all">{business.subscriptionId}</span> in your PayPal account.
                    </p>
                  ) : null}
                  <p className="text-sm text-ink-muted">
                    Lifting the ban opens the business again as it was left.
                    {business.subscriptionId
                      ? " Its plan stays cancelled, so once any time already paid for runs out they choose a plan again."
                      : null}
                  </p>
                  <form action={liftBanAction}>
                    <input type="hidden" name="id" value={business.id} />
                    <SubmitButton variant="outline" size="md" pendingLabel="Lifting…">
                      Lift the ban
                    </SubmitButton>
                  </form>
                </>
              ) : (
                <BanForm id={business.id} />
              )}
            </CardBody>
          </Card>

          <Card className="border-danger/40">
            <CardHeader
              title={
                <span className="inline-flex items-center gap-2">
                  <Trash2 className="h-4 w-4 text-danger" strokeWidth={1.75} />
                  Delete
                </span>
              }
              description="Removes the business and everything in it: people, clients, jobs, estimates, invoices, payments and files. It can’t be undone. Its plan with you is cancelled first, and so is any auto-pay its customers set up. Its emails are freed, so the same people could sign up again — to keep them out, ban instead."
            />
            <CardBody>
              <DeleteForm id={business.id} name={business.name} />
            </CardBody>
          </Card>
        </>
      )}
    </div>
  );
}
