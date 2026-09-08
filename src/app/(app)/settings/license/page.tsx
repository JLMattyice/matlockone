import type { Metadata } from "next";
import { CheckCircle2, TriangleAlert } from "lucide-react";

import { clearLicense } from "./actions";
import { LicenseForm, RemoveLicenseButton } from "./license-form";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { requirePermission } from "@/lib/auth";
import { prisma } from "@/lib/db";
import {
  DEMO_SEATS,
  daysRemaining,
  licenseState,
  licenseSummary,
} from "@/lib/license/status";
import { can } from "@/lib/permissions";

export const metadata: Metadata = { title: "Licence" };

export default async function LicenseSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ seats?: string }>;
}) {
  // Read to look, write to change — the same split the business settings use.
  // A manager who cannot buy anything can still see why they were stopped.
  const { user, org } = await requirePermission("settings:read");
  const canWrite = can(user, "settings:write");
  const { seats } = await searchParams;

  const state = licenseState(org.licenseKey);
  const remaining = daysRemaining(state);

  const activeUsers = await prisma.user.count({
    where: { organizationId: org.id, isActive: true },
  });

  const limit = state.seats;
  const overLimit = limit !== null && activeUsers > limit;

  return (
    <div className="space-y-6">
      {/* Arrived here from a blocked reactivation, so say why up front. */}
      {seats === "full" ? (
        <div
          role="alert"
          className="flex gap-3 rounded-card border border-warning/30 bg-warning/10 p-4"
        >
          <TriangleAlert
            className="mt-0.5 h-5 w-5 shrink-0 text-warning"
            strokeWidth={1.75}
            aria-hidden
          />
          <div className="text-sm">
            <p className="font-medium text-ink">
              That would put you over your seat limit
            </p>
            <p className="mt-1 text-ink-muted">
              Nobody was deactivated and nothing was lost. Enter a licence with
              more seats, or deactivate someone else first.
            </p>
          </div>
        </div>
      ) : null}

      <Card>
        <CardHeader
          title="Current licence"
          action={
            state.kind === "licensed" ? (
              <Badge tone="success" dot>
                Active
              </Badge>
            ) : (
              <Badge tone={state.reason ? "warning" : "neutral"} dot>
                {state.reason === "expired" ? "Expired" : "Demo"}
              </Badge>
            )
          }
        />
        <CardBody className="space-y-4">
          <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
            <div>
              <dt className="text-xs text-ink-subtle">Plan</dt>
              <dd className="mt-0.5 text-sm text-ink">
                {licenseSummary(state)}
              </dd>
            </div>

            <div>
              <dt className="text-xs text-ink-subtle">People</dt>
              <dd className="tabular mt-0.5 text-sm text-ink">
                {activeUsers} active
                {limit === null ? " · unlimited" : ` of ${limit}`}
              </dd>
            </div>

            {state.kind === "licensed" ? (
              <>
                <div>
                  <dt className="text-xs text-ink-subtle">Issued to</dt>
                  <dd className="mt-0.5 text-sm text-ink">
                    {state.license.sub}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-ink-subtle">Renews</dt>
                  <dd className="tabular mt-0.5 text-sm text-ink">
                    {new Date(state.license.exp * 1000).toLocaleDateString()}
                    {remaining !== null && remaining <= 30 ? (
                      <span className="ml-2 text-warning">
                        {remaining} days left
                      </span>
                    ) : null}
                  </dd>
                </div>
              </>
            ) : null}
          </dl>

          {state.kind === "demo" ? (
            <p className="text-sm text-ink-muted">
              {state.message
                ? `${state.message} `
                : "This workspace is running in demo mode. "}
              Everything works; you can have up to {DEMO_SEATS} active people
              until a licence is entered. Nothing you have entered is at risk,
              and none of it is deleted when you activate.
            </p>
          ) : null}

          {overLimit ? (
            <p className="text-sm text-warning">
              You have more active people than this licence covers. Nobody has
              been deactivated — you simply cannot add another until you are
              back within {limit}.
            </p>
          ) : null}

          {state.kind === "licensed" ? (
            <div className="flex items-center gap-3 pt-1">
              <CheckCircle2
                className="h-4 w-4 shrink-0 text-success"
                strokeWidth={1.75}
                aria-hidden
              />
              <p className="mr-auto text-sm text-ink-muted">
                Verified on this machine, without contacting a server.
              </p>
              {canWrite ? <RemoveLicenseButton action={clearLicense} /> : null}
            </div>
          ) : null}
        </CardBody>
      </Card>

      {canWrite ? (
        <LicenseForm licensed={state.kind === "licensed"} />
      ) : (
        <p className="text-sm text-ink-subtle">
          Ask an owner or administrator to change the licence.
        </p>
      )}
    </div>
  );
}
