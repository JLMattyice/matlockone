import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CalendarDays, CheckCircle2, FileText, MessageSquarePlus, Receipt } from "lucide-react";

import { ShareRefused } from "@/app/share/refused";
import { formatMoney } from "@/lib/money";
import { portalView } from "@/lib/portal";
import { shareAllowed, shareMissed } from "@/lib/share-guard";
import { formatIn } from "@/lib/time-zone";
import { DEFAULT_BRAND_COLOR, formatPhone, hexToRgbChannels } from "@/lib/utils";

export const metadata: Metadata = {
  title: "Your account",
  // A customer's private page: not for search engines or link previews.
  robots: { index: false, follow: false },
};

/**
 * A customer's own page with the business: what is booked, what was done,
 * what is waiting for their answer, what is owed and what was paid — and a
 * way to ask for more work. Every estimate and invoice opens on the link the
 * customer would have been emailed, where they can accept, sign and pay.
 */
export default async function PortalPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  const allowed = await shareAllowed();
  if (!allowed.ok) return <ShareRefused retryAfterSeconds={allowed.retryAfterSeconds} />;

  const view = await portalView(token);
  if (!view) {
    await shareMissed();
    notFound();
  }

  const { client, org, upcoming, past, toAnswer, answered, toPay, paid } = view;
  const brand = hexToRgbChannels(org.primaryColor) ? org.primaryColor : DEFAULT_BRAND_COLOR;
  const money = (cents: number) => formatMoney(cents, org.currency, org.locale);
  const day = (date: Date) => formatIn(date, "EEE, MMM d, yyyy", org.timeZone);
  const time = (date: Date) => formatIn(date, "h:mm a", org.timeZone);
  const owed = toPay.reduce((sum, invoice) => sum + invoice.balanceCents, 0);

  return (
    <div
      style={{ "--brand": brand } as React.CSSProperties}
      className="min-h-screen bg-surface-2 px-4 py-8 sm:py-12"
    >
      <div className="mx-auto max-w-3xl space-y-5">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            {org.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={org.logoUrl} alt="" className="h-10 w-10 shrink-0 rounded-lg object-contain" />
            ) : null}
            <div className="min-w-0">
              <p className="truncate text-sm text-ink-muted">{org.name}</p>
              <h1 className="truncate text-xl font-semibold tracking-tight text-ink">
                Hello, {client.firstName || client.displayName}
              </h1>
            </div>
          </div>
          {org.requestsEnabled && !org.isDemo ? (
            <a
              href={`/request/${org.slug}?for=${encodeURIComponent(token)}`}
              style={{ backgroundColor: brand }}
              className="inline-flex h-10 items-center gap-2 rounded-lg px-4 text-sm font-medium text-white shadow-sm transition-[filter] hover:brightness-110"
            >
              <MessageSquarePlus className="h-4 w-4" strokeWidth={2} />
              Request more work
            </a>
          ) : null}
        </header>

        {owed > 0 ? (
          <div className="rounded-card border border-line bg-surface px-5 py-4">
            <p className="text-sm text-ink-muted">Balance to pay</p>
            <p className="tabular text-2xl font-semibold text-ink">{money(owed)}</p>
          </div>
        ) : null}

        <Section icon={<CalendarDays className="h-4 w-4" strokeWidth={2} />} title="Coming up">
          {upcoming.length === 0 ? (
            <Empty>Nothing booked right now.</Empty>
          ) : (
            upcoming.map((job) => (
              <Row key={job.id}>
                <div className="min-w-0">
                  <p className="font-medium text-ink">{job.title}</p>
                  {job.address ? (
                    <p className="truncate text-xs text-ink-subtle">
                      {[job.address.line1, job.address.city].filter(Boolean).join(", ")}
                    </p>
                  ) : null}
                </div>
                <p className="shrink-0 text-right text-sm text-ink-muted">
                  {job.scheduledStart ? (
                    <>
                      {day(job.scheduledStart)}
                      <br />
                      <span className="text-xs">{job.allDay ? "All day" : time(job.scheduledStart)}</span>
                    </>
                  ) : (
                    "Date to be set"
                  )}
                </p>
              </Row>
            ))
          )}
        </Section>

        {toAnswer.length > 0 ? (
          <Section icon={<FileText className="h-4 w-4" strokeWidth={2} />} title={`${org.labelEstimatePlural} for you to look at`}>
            {toAnswer.map((estimate) => (
              <Row key={estimate.id}>
                <div className="min-w-0">
                  <p className="font-medium text-ink">{estimate.title || estimate.number}</p>
                  <p className="text-xs text-ink-subtle">
                    {estimate.number}
                    {estimate.expiresAt ? ` · valid until ${day(estimate.expiresAt)}` : ""}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <span className="tabular text-sm text-ink">{money(estimate.totalCents)}</span>
                  <Action href={`/share/estimate/${estimate.publicToken}`} brand={brand}>
                    Review
                  </Action>
                </div>
              </Row>
            ))}
          </Section>
        ) : null}

        <Section icon={<Receipt className="h-4 w-4" strokeWidth={2} />} title="Invoices">
          {toPay.length === 0 && paid.length === 0 ? (
            <Empty>No invoices yet.</Empty>
          ) : (
            <>
              {toPay.map((invoice) => (
                <Row key={invoice.id}>
                  <div className="min-w-0">
                    <p className="font-medium text-ink">{invoice.title || invoice.number}</p>
                    <p className={invoice.status === "OVERDUE" ? "text-xs text-danger" : "text-xs text-ink-subtle"}>
                      {invoice.number}
                      {invoice.dueDate
                        ? ` · ${invoice.status === "OVERDUE" ? "was due" : "due"} ${day(invoice.dueDate)}`
                        : ""}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <span className="tabular text-sm text-ink">{money(invoice.balanceCents)}</span>
                    <Action href={`/share/invoice/${invoice.publicToken}`} brand={brand}>
                      Pay
                    </Action>
                  </div>
                </Row>
              ))}
              {paid.map((invoice) => (
                <Row key={invoice.id}>
                  <div className="min-w-0">
                    <p className="font-medium text-ink">{invoice.title || invoice.number}</p>
                    <p className="text-xs text-ink-subtle">
                      {invoice.number}
                      {invoice.paidAt ? ` · paid ${day(invoice.paidAt)}` : " · paid"}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <span className="tabular text-sm text-ink-muted">{money(invoice.totalCents)}</span>
                    <a
                      href={`/share/invoice/${invoice.publicToken}`}
                      className="text-sm font-medium text-brand hover:underline"
                    >
                      Receipt
                    </a>
                  </div>
                </Row>
              ))}
            </>
          )}
        </Section>

        {past.length > 0 || answered.length > 0 ? (
          <Section icon={<CheckCircle2 className="h-4 w-4" strokeWidth={2} />} title="Work done">
            {past.map((job) => (
              <Row key={job.id}>
                <p className="min-w-0 truncate font-medium text-ink">{job.title}</p>
                <p className="shrink-0 text-sm text-ink-muted">
                  {job.completedAt ? day(job.completedAt) : job.scheduledStart ? day(job.scheduledStart) : ""}
                </p>
              </Row>
            ))}
            {answered.map((estimate) => (
              <Row key={estimate.id}>
                <p className="min-w-0 truncate text-ink">
                  Accepted: {estimate.title || estimate.number}
                </p>
                <a
                  href={`/share/estimate/${estimate.publicToken}`}
                  className="shrink-0 text-sm font-medium text-brand hover:underline"
                >
                  View
                </a>
              </Row>
            ))}
          </Section>
        ) : null}

        <footer className="pt-2 pb-6 text-center text-xs text-ink-subtle">
          Questions? Contact {org.name}
          {org.phone ? ` on ${formatPhone(org.phone)}` : ""}
          {org.email ? ` or at ${org.email}` : ""}.
          <br />
          This page is private to you. Anyone with its link can see it, so keep it to yourself.
        </footer>
      </div>
    </div>
  );
}

function Section({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <section className="overflow-hidden rounded-card border border-line bg-surface">
      <h2 className="flex items-center gap-2 border-b border-line px-5 py-3 text-sm font-semibold text-ink">
        <span className="text-ink-subtle">{icon}</span>
        {title}
      </h2>
      <ul className="divide-y divide-line">{children}</ul>
    </section>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return <li className="flex items-center justify-between gap-4 px-5 py-3 text-sm">{children}</li>;
}

function Empty({ children }: { children: React.ReactNode }) {
  return <li className="px-5 py-4 text-sm text-ink-subtle">{children}</li>;
}

function Action({ href, brand, children }: { href: string; brand: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      style={{ backgroundColor: brand }}
      className="inline-flex h-8 items-center rounded-lg px-3 text-xs font-medium text-white shadow-sm transition-[filter] hover:brightness-110"
    >
      {children}
    </a>
  );
}
