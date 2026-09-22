"use server";

import { revalidatePath } from "next/cache";

import { failed, saved, type ActionState } from "@/lib/action-state";
import { requirePermission } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { resolveConfig, templateById } from "@/lib/workflows/templates";
import { sweep } from "@/lib/workflows/run";

/**
 * Turning automations on and off, and running the ones that wait for a sweep.
 *
 * Settings, so settings:write guards them — the same permission that renames
 * the records and sets the tax rate. An automation raises tasks for everybody,
 * which is not a technician's decision to make.
 */

export async function setWorkflowActive(formData: FormData) {
  const { user, org } = await requirePermission("settings:write");

  const templateId = String(formData.get("templateId") ?? "");
  const template = templateById(templateId);
  if (!template) return;

  const isActive = String(formData.get("isActive") ?? "") === "true";

  // Upsert on (organization, template): a row exists once the automation has
  // ever been touched, and its absence means "never turned on".
  await prisma.workflow.upsert({
    where: {
      organizationId_templateId: { organizationId: org.id, templateId },
    },
    create: {
      organizationId: org.id,
      templateId,
      isActive,
      createdById: user.id,
    },
    update: { isActive },
  });

  revalidatePath("/settings/automations");
}

export async function updateWorkflowSettings(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { user, org } = await requirePermission("settings:write");

  const templateId = String(formData.get("templateId") ?? "");
  const template = templateById(templateId);
  if (!template) return failed("That automation no longer exists.");

  // Straight through resolveConfig, which clamps every number into the
  // template's own range — so a hand-edited form cannot set a chase to fire
  // nine thousand days late, or zero days early.
  const config = resolveConfig(
    template,
    JSON.stringify({
      days: Number(formData.get("days")),
      dueInDays: Number(formData.get("dueInDays")),
    }),
  );

  await prisma.workflow.upsert({
    where: {
      organizationId_templateId: { organizationId: org.id, templateId },
    },
    create: {
      organizationId: org.id,
      templateId,
      isActive: true,
      config: JSON.stringify(config),
      createdById: user.id,
    },
    update: { config: JSON.stringify(config) },
  });

  revalidatePath("/settings/automations");
  return saved("Saved.");
}

/**
 * Runs the sweep and says what it did.
 *
 * Nothing in either deployment wakes up on its own, so this is the button that
 * stands in for a scheduler. It reports the tasks it raised rather than a bare
 * "done", because an automation that claims success and shows nothing is
 * indistinguishable from one that is broken.
 */
export async function runWorkflowSweep(
  _prev: ActionState,
  _formData: FormData,
): Promise<ActionState> {
  const { org } = await requirePermission("settings:write");

  const outcomes = await sweep(org.id);
  const created = outcomes.flatMap((outcome) => outcome.created);

  revalidatePath("/settings/automations");
  revalidatePath("/tasks");
  revalidatePath("/dashboard");

  if (created.length === 0) {
    return saved("Nothing to do — every automation is up to date.");
  }

  return saved(
    created.length === 1
      ? `Raised 1 task: ${created[0]}`
      : `Raised ${created.length} tasks.`,
  );
}
