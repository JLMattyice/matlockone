import type { Metadata } from "next";
import Link from "next/link";
import { BookOpen } from "lucide-react";

import { disconnectQuickBooks, setQuickBooksOverwrite } from "./actions";
import { SendNow } from "./send-now";
import { Badge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/card";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { FormError, FormSuccess } from "@/components/ui/form";
import { SubmitButton } from "@/components/ui/submit";
import { requirePermission } from "@/lib/auth";
import { dataStaysOnThisMachine } from "@/lib/config";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { loadConnection, quickbooksStatus } from "@/lib/quickbooks/connection";
import { quickbooksSettings } from "@/lib/quickbooks/settings";
import { customerSyncSummary } from "@/lib/quickbooks/sync";
import { encryptionAvailable } from "@/lib/secret-box";
import { formatIn } from "@/lib/time-zone";
import { viewerTimeZone } from "@/lib/viewer-time-zone";

export const metadata: Metadata = { title: "QuickBooks" };

// Send now works through as many customers as it can in this long.
export const maxDuration = 60;

const PROBLEMS: Record<string, string> = {
  unavailable: "QuickBooks is not available on this copy of Matlock One.",
  encryption:
    "This deployment cannot store a connection safely yet — ENCRYPTION_KEY is not set.",
  expired:
    "That QuickBooks sign-in took too long, or was started by someone else. Connect again from here.",
  declined: "QuickBooks was not connected — the request was cancelled at Intuit.",
  refused:
    "QuickBooks did not accept the connection. Try again; if it keeps happening, this deployment's Intuit keys need checking.",
};

function count(n: number, one: string, many: string) {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

export default async function QuickBooksSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ connected?: string; problem?: string }>;
}) {
  const { user, org } = await requirePermission("settings:read");
  const params = await searchParams;
  const zone = await viewerTimeZone();
  const writable = can(user, "settings:write");

  const available = Boolean(quickbooksSettings());
  const status = await quickbooksStatus(org.id);
  const problem = params.problem ? (PROBLEMS[params.problem] ?? PROBLEMS.refused) : null;

  const intro = (
    <CardHeader
      title="QuickBooks Online"
      description="Keep QuickBooks' customer list matching this one, without typing anybody in twice. Invoices and payments come next."
    />
  );

  if (!status) {
    return (
      <div className="space-y-4">
        <FormError>{problem}</FormError>
        <Card>
          {intro}
          <CardBody className="space-y-3 text-sm text-ink-muted">
            {available ? (
              <>
                <p>Once connected:</p>
                <ul className="list-disc space-y-1.5 pl-5">
                  <li>Every customer that is not archived goes to QuickBooks.</li>
                  <li>
                    A customer you add or change goes over a moment after you save. Anything that
                    could not go over is tried again in the morning, and Send now does it on the
                    spot.
                  </li>
                  <li>
                    A customer QuickBooks already has under the same name is linked rather than
                    duplicated. Whether its details there are replaced with these is your choice.
                  </li>
                  <li>Nothing is sent until you press Send now the first time.</li>
                </ul>
              </>
            ) : dataStaysOnThisMachine() ? (
              <p>
                QuickBooks connects to your online account. Sign in at matlockone.com to connect
                it there.
              </p>
            ) : (
              <p>
                QuickBooks is not set up on this deployment yet: it needs Intuit app keys
                (QUICKBOOKS_CLIENT_ID and QUICKBOOKS_CLIENT_SECRET).
              </p>
            )}
          </CardBody>
          {available && writable ? (
            <CardFooter>
              {encryptionAvailable() ? (
                // A plain link, not <Link>: prefetching it would start the
                // handshake with Intuit before anybody clicked.
                <a href="/api/integrations/quickbooks/connect" className={buttonClasses("primary", "md")}>
                  <BookOpen className="h-4 w-4" strokeWidth={1.75} />
                  Connect to QuickBooks
                </a>
              ) : (
                <p className="text-sm text-danger">{PROBLEMS.encryption}</p>
              )}
            </CardFooter>
          ) : null}
        </Card>
      </div>
    );
  }

  const connection = await loadConnection(org.id);
  const summary = connection ? await customerSyncSummary(connection) : null;
  const total = await prisma.client.count({
    where: { organizationId: org.id, status: { not: "ARCHIVED" } },
  });
  const company = status.companyName || "your QuickBooks company";
  // The "just connected" note stops making sense once Send now has been
  // pressed on this connection, though the address still says ?connected=1.
  const sentSinceConnecting =
    Boolean(status.firstSentAt) && status.firstSentAt! > status.connectedAt;
  const needsReconnect = status.needsReconnect || !connection;

  return (
    <div className="space-y-4">
      <FormError>{problem}</FormError>
      {params.connected && !problem && !sentSinceConnecting ? (
        <FormSuccess>
          Connected to {company}.{" "}
          {status.firstSentAt
            ? "Sending carries on from where it left off."
            : "Nothing has been sent yet — check the switch below, then press Send now."}
        </FormSuccess>
      ) : null}

      <Card>
        <CardHeader
          title={
            <span className="flex flex-wrap items-center gap-2">
              Connected to {company}
              {status.environment === "sandbox" ? <Badge tone="warning">Sandbox</Badge> : null}
            </span>
          }
          description={
            status.connectedAt
              ? `Connected ${formatIn(new Date(status.connectedAt), "MMM d, yyyy 'at' h:mm a", zone)}`
              : undefined
          }
        />
        <CardBody className="space-y-4">
          {needsReconnect ? (
            <div className="space-y-3">
              <FormError>
                QuickBooks stopped accepting this connection — it was disconnected from the
                QuickBooks side, or went unused for too long. Nothing is being sent until it is
                connected again.
              </FormError>
              {writable && available ? (
                <a href="/api/integrations/quickbooks/connect" className={buttonClasses("primary", "md")}>
                  Connect again
                </a>
              ) : null}
            </div>
          ) : summary ? (
            <>
              <div className="flex flex-wrap gap-2">
                <Badge tone="success">{count(summary.sent, "customer in QuickBooks", "customers in QuickBooks")}</Badge>
                {summary.waiting > 0 ? (
                  <Badge>{count(summary.waiting, "waiting", "waiting")}</Badge>
                ) : null}
                {summary.failing.length > 0 ? (
                  <Badge tone="danger">{count(summary.failing.length, "could not be sent", "could not be sent")}</Badge>
                ) : null}
              </div>
              <p className="text-sm text-ink-muted">
                {status.firstSentAt
                  ? `${org.labelClientPlural} you add or change go over a moment after you save; the morning run tries again whatever could not. ${total === summary.sent && summary.waiting === 0 ? "Everything is up to date." : ""}`
                  : `Nothing has gone over yet. ${count(summary.waiting, `${org.labelClientSingular.toLowerCase()} is`, `${org.labelClientPlural.toLowerCase()} are`)} ready. After the first Send now, changes go over by themselves.`}
              </p>
              {writable ? <SendNow /> : null}
            </>
          ) : null}
        </CardBody>
      </Card>

      {summary && summary.failing.length > 0 ? (
        <Card>
          <CardHeader
            title="Could not be sent"
            description="Fix what QuickBooks says, and the customer goes over again on the next save, Send now or morning run."
          />
          <ul className="divide-y divide-line">
            {summary.failing.slice(0, 25).map((row) => (
              <li key={row.id} className="px-5 py-3 text-sm">
                <Link href={`/clients/${row.id}`} className="font-medium text-ink hover:text-brand">
                  {row.name}
                </Link>
                <p className="mt-0.5 text-ink-muted">{row.error}</p>
              </li>
            ))}
          </ul>
          {summary.failing.length > 25 ? (
            <p className="border-t border-line px-5 py-3 text-xs text-ink-subtle">
              and {count(summary.failing.length - 25, "more", "more")}
            </p>
          ) : null}
        </Card>
      ) : null}

      <Card>
        <CardHeader
          title="Customers QuickBooks already has"
          description="When QuickBooks has a customer with the same name, Matlock One links to it rather than making a second one."
        />
        <form action={setQuickBooksOverwrite}>
          <CardBody className="space-y-2 text-sm text-ink-muted">
            <p>
              {status.overwriteMatches
                ? "On: a matched customer's email, phones, website and addresses in QuickBooks are replaced with the ones here, and kept up to date from then on."
                : "Off: a matched customer is used as QuickBooks has it and never changed from here. Customers Matlock One adds to QuickBooks are still kept up to date."}
            </p>
            <input type="hidden" name="overwrite" value={status.overwriteMatches ? "off" : "on"} />
          </CardBody>
          {writable ? (
            <CardFooter>
              <SubmitButton variant="outline" pendingLabel="Saving…">
                {status.overwriteMatches ? "Turn overwriting off" : "Turn overwriting on"}
              </SubmitButton>
            </CardFooter>
          ) : null}
        </form>
      </Card>

      {writable ? (
        <Card>
          <CardHeader
            title="Disconnect"
            description="Stops sending. Everything already in QuickBooks stays there, and connecting the same company again carries on where it left off."
          />
          <form action={disconnectQuickBooks}>
            <CardFooter>
              <ConfirmButton variant="outline" confirmLabel="Disconnect QuickBooks?" pendingLabel="Disconnecting…">
                Disconnect QuickBooks
              </ConfirmButton>
            </CardFooter>
          </form>
        </Card>
      ) : null}
    </div>
  );
}
