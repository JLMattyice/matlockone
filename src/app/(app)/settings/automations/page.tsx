import type { Metadata } from "next";

import { AutomationsForm } from "./automations-form";
import { requirePermission } from "@/lib/auth";
import { sweepSchedule } from "@/lib/config";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { workflowRunCount, workflowSettings } from "@/lib/workflows/run";

export const metadata: Metadata = { title: "Automations" };

export default async function AutomationsPage() {
  const { user, org } = await requirePermission("settings:read");

  const [rows, raised, mail] = await Promise.all([
    workflowSettings(org.id),
    workflowRunCount(org.id),
    prisma.integration.findUnique({
      where: { organizationId_kind: { organizationId: org.id, kind: "EMAIL" } },
      select: { isActive: true },
    }),
  ]);

  return (
    <AutomationsForm
      // The template is a plain object from a client-safe module, so it
      // crosses to the browser intact; only the dates need narrowing.
      automations={rows.map((row) => ({
        template: row.template,
        isActive: row.isActive,
        config: row.config,
        scheduled: row.scheduled,
        lastRunAt: row.lastRunAt ? row.lastRunAt.toISOString() : null,
      }))}
      raised={raised}
      reviewUrl={org.reviewUrl}
      emailConnected={Boolean(mail?.isActive)}
      automatic={sweepSchedule()}
      readOnly={!can(user, "settings:write")}
    />
  );
}
