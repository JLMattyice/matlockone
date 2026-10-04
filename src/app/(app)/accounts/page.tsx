import type { Metadata } from "next";
import { Building2, CircleDollarSign, UserPlus, Users } from "lucide-react";

import { allBusinesses, newestPeople, type BusinessRow } from "./queries";
import { StatTile } from "@/components/dashboard/stat-tile";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState, PageHeader } from "@/components/ui/page-header";
import { TabLinks } from "@/components/ui/tab-links";
import { Table, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import {
  isStanding,
  planLabel,
  STANDING_META,
  STANDINGS,
  standingOf,
  summarizeAccounts,
  type Standing,
} from "@/lib/accounts-overview";
import { PLAN_ORDER, PLANS } from "@/lib/checkout/plans";
import { asStatus, ROLE_META, ROLES, type Role } from "@/lib/constants";
import { formatMoney } from "@/lib/money";
import { requireOperator } from "@/lib/operator";
import { formatIn } from "@/lib/time-zone";
import { viewerTimeZone } from "@/lib/viewer-time-zone";

export const metadata: Metadata = { title: "Accounts" };

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The operator's view of Matlock One: who has signed up, who pays, and what
 * it adds up to. Every other page is one business looking at itself; this one
 * looks across all of them, so it answers only to OPERATOR_EMAILS.
 */
export default async function AccountsPage({
  searchParams,
}: {
  searchParams: Promise<{ show?: string }>;
}) {
  await requireOperator();
  const { show } = await searchParams;
  const filter: Standing | null = isStanding(show) ? show : null;

  const now = new Date();
  const [businesses, people, zone] = await Promise.all([
    allBusinesses(),
    newestPeople(),
    viewerTimeZone(),
  ]);

  const summary = summarizeAccounts(businesses, now);
  const rows = businesses
    .map((business) => ({ business, standing: standingOf(business, now) }))
    .filter((row) => !filter || row.standing === filter);

  const everyone = businesses.flatMap((business) => business.users);
  const activePeople = everyone.filter((user) => user.isActive).length;
  const signedInThisWeek = everyone.filter(
    (user) => user.lastLoginAt && now.getTime() - user.lastLoginAt.getTime() < WEEK_MS,
  ).length;

  const paying = summary.byStanding.paying;
  const day = (date: Date) => formatIn(date, "MMM d, yyyy", zone);
  const lastSeen = (date: Date | null) => (date ? formatIn(date, "MMM d, h:mm a", zone) : "Never");

  return (
    <div className="space-y-6">
      <PageHeader
        title="Accounts"
        description="Every business on Matlock One, and where it stands. Only you can see this page."
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="Paying businesses"
          value={String(paying)}
          sublabel={PLAN_ORDER.map((plan) => `${PLANS[plan].name} ${summary.byPlan[plan]}`).join(" · ")}
          icon={CircleDollarSign}
          tone="success"
          href="/accounts?show=paying"
        />
        <StatTile
          label="Monthly revenue"
          value={formatMoney(summary.monthlyCents)}
          sublabel={`${formatMoney(summary.monthlyCents * 12)} a year at this rate`}
          icon={CircleDollarSign}
          tone="brand"
        />
        <StatTile
          label="Businesses signed up"
          value={String(summary.businesses)}
          sublabel={`${summary.newThisWeek} this week · ${summary.newThisMonth} in 30 days`}
          icon={Building2}
        />
        <StatTile
          label="People"
          value={String(activePeople)}
          sublabel={`${signedInThisWeek} signed in this week`}
          icon={Users}
        />
      </div>

      <Card>
        <CardHeader
          title="Businesses"
          description="Newest first. The owner is whoever made the account."
        />
        <div className="px-4 pt-1">
          <TabLinks
            tabs={[
              { href: "/accounts", label: "All", count: summary.businesses, active: !filter },
              ...STANDINGS.filter((standing) => summary.byStanding[standing] > 0 || standing === filter).map(
                (standing) => ({
                  href: `/accounts?show=${standing}`,
                  label: STANDING_META[standing].label,
                  count: summary.byStanding[standing],
                  active: filter === standing,
                }),
              ),
            ]}
          />
        </div>

        {rows.length === 0 ? (
          <EmptyState
            icon={<Building2 className="h-5 w-5" strokeWidth={1.75} />}
            title={filter ? `No businesses are ${STANDING_META[filter].label.toLowerCase()}` : "No businesses yet"}
            description={filter ? "Pick another tab to see the rest." : "Sign-ups will show here as they come in."}
          />
        ) : (
          <Table>
            <THead>
              <Th>Business</Th>
              <Th>Owner</Th>
              <Th>Plan</Th>
              <Th>Status</Th>
              <Th className="hidden md:table-cell">Paid through</Th>
              <Th align="right" className="hidden sm:table-cell">
                People
              </Th>
              <Th className="hidden lg:table-cell">Last sign-in</Th>
            </THead>
            <TBody>
              {rows.map(({ business, standing }) => (
                <BusinessLine
                  key={business.id}
                  business={business}
                  standing={standing}
                  day={day}
                  lastSeen={lastSeen}
                />
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      <Card>
        <CardHeader
          title="Newest accounts"
          description="The last 50 people to get a sign-in — owners who signed up, and the team they added."
        />
        {people.length === 0 ? (
          <EmptyState
            icon={<UserPlus className="h-5 w-5" strokeWidth={1.75} />}
            title="Nobody yet"
            description="New accounts will show here."
          />
        ) : (
          <Table>
            <THead>
              <Th>Person</Th>
              <Th>Business</Th>
              <Th className="hidden sm:table-cell">Role</Th>
              <Th>Joined</Th>
              <Th className="hidden md:table-cell">Last sign-in</Th>
            </THead>
            <TBody>
              {people.map((person) => (
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
                  <Td className="text-ink-muted">{person.organization.name}</Td>
                  <Td className="hidden text-ink-muted sm:table-cell">{roleLabel(person.role)}</Td>
                  <Td className="tabular whitespace-nowrap text-ink-muted">{day(person.createdAt)}</Td>
                  <Td className="tabular hidden whitespace-nowrap text-ink-muted md:table-cell">
                    {lastSeen(person.lastLoginAt)}
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </div>
  );
}

function BusinessLine({
  business,
  standing,
  day,
  lastSeen,
}: {
  business: BusinessRow;
  standing: Standing;
  day: (date: Date) => string;
  lastSeen: (date: Date | null) => string;
}) {
  const meta = STANDING_META[standing];
  const owner = business.users.find((user) => user.role === "OWNER") ?? business.users[0] ?? null;
  const active = business.users.filter((user) => user.isActive).length;
  const latest = business.users.reduce<Date | null>(
    (latest, user) =>
      user.lastLoginAt && (!latest || user.lastLoginAt > latest) ? user.lastLoginAt : latest,
    null,
  );

  return (
    <Tr>
      <Td>
        <span className="block font-medium">{business.name}</span>
        <span className="block text-xs text-ink-subtle">Signed up {day(business.createdAt)}</span>
      </Td>
      <Td>
        {owner ? (
          <>
            <span className="block">{owner.name}</span>
            <span className="block text-xs break-all text-ink-subtle">{owner.email}</span>
          </>
        ) : (
          <span className="text-ink-subtle">—</span>
        )}
      </Td>
      <Td className="whitespace-nowrap text-ink-muted">{planLabel(business) ?? "—"}</Td>
      <Td>
        <span title={meta.hint}>
          <Badge tone={meta.tone} dot>
            {meta.label}
          </Badge>
        </span>
      </Td>
      <Td className="tabular hidden whitespace-nowrap text-ink-muted md:table-cell">
        {business.paidThrough ? day(business.paidThrough) : "—"}
      </Td>
      <Td align="right" className="tabular hidden text-ink-muted sm:table-cell">
        {active}
      </Td>
      <Td className="tabular hidden whitespace-nowrap text-ink-muted lg:table-cell">{lastSeen(latest)}</Td>
    </Tr>
  );
}

function roleLabel(role: string) {
  return ROLE_META[asStatus(ROLES, role, "EMPLOYEE") as Role].label;
}
