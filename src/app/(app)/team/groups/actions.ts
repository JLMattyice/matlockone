"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { failed, invalid, saved, text, type ActionState } from "@/lib/action-state";
import { requirePermission } from "@/lib/auth";
import { prisma } from "@/lib/db";

import { leadOf, realMemberIds } from "./queries";

/**
 * Creating and editing groups.
 *
 * Membership is submitted as the complete set rather than as add/remove
 * operations, so the form is the whole truth and two people editing at once
 * cannot interleave into a state neither of them chose.
 */

const groupSchema = z.object({
  name: z.string().trim().min(2, "Give the group a name."),
  description: z.string().trim().nullish(),
  leadId: z.string().trim().nullish(),
});

function parseForm(formData: FormData) {
  return groupSchema.safeParse({
    name: formData.get("name"),
    description: text(formData, "description"),
    leadId: text(formData, "leadId"),
  });
}

/** The submitted membership, filtered to people who really are on the team. */
function memberIds(organizationId: string, formData: FormData) {
  const submitted = formData
    .getAll("memberIds")
    .filter((value): value is string => typeof value === "string" && value !== "");

  return realMemberIds(organizationId, submitted);
}

export async function createGroup(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { org } = await requirePermission("employees:write");

  const parsed = parseForm(formData);
  if (!parsed.success) return invalid(parsed.error);

  const members = await memberIds(org.id, formData);

  const clash = await prisma.group.findFirst({
    where: { organizationId: org.id, name: parsed.data.name },
    select: { id: true },
  });
  if (clash) {
    return { ok: false, fieldErrors: { name: "A group already has that name." } };
  }

  const group = await prisma.group.create({
    data: {
      organizationId: org.id,
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      leadId: leadOf(parsed.data.leadId, members),
      members: { create: members.map((userId) => ({ userId })) },
    },
    select: { id: true },
  });

  revalidatePath("/team/groups");
  redirect(`/team/groups/${group.id}`);
}

export async function updateGroup(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { org } = await requirePermission("employees:write");

  const id = String(formData.get("groupId") ?? "");
  const existing = await prisma.group.findFirst({
    where: { id, organizationId: org.id },
    select: { id: true },
  });
  if (!existing) return failed("That group no longer exists.");

  const parsed = parseForm(formData);
  if (!parsed.success) return invalid(parsed.error);

  const members = await memberIds(org.id, formData);

  const clash = await prisma.group.findFirst({
    where: {
      organizationId: org.id,
      name: parsed.data.name,
      id: { not: existing.id },
    },
    select: { id: true },
  });
  if (clash) {
    return { ok: false, fieldErrors: { name: "A group already has that name." } };
  }

  await prisma.$transaction([
    prisma.groupMember.deleteMany({ where: { groupId: existing.id } }),
    prisma.group.update({
      where: { id: existing.id },
      data: {
        name: parsed.data.name,
        description: parsed.data.description ?? null,
        leadId: leadOf(parsed.data.leadId, members),
        members: { create: members.map((userId) => ({ userId })) },
      },
    }),
  ]);

  revalidatePath("/team/groups");
  revalidatePath(`/team/groups/${existing.id}`);
  return saved("Group saved.");
}

/**
 * Retires a group without deleting it.
 *
 * Jobs keep pointing at it, so last quarter's work still says who did it. It
 * simply stops being offered when assigning anything new.
 */
export async function setGroupActive(formData: FormData) {
  const { org } = await requirePermission("employees:write");

  const id = String(formData.get("groupId") ?? "");
  const isActive = formData.get("isActive") === "true";

  const group = await prisma.group.findFirst({
    where: { id, organizationId: org.id },
    select: { id: true },
  });
  if (!group) return;

  await prisma.group.update({ where: { id: group.id }, data: { isActive } });

  revalidatePath("/team/groups");
  revalidatePath(`/team/groups/${group.id}`);
}

export async function deleteGroup(formData: FormData) {
  const { org } = await requirePermission("employees:write");

  const id = String(formData.get("groupId") ?? "");
  const group = await prisma.group.findFirst({
    where: { id, organizationId: org.id },
    select: { id: true, _count: { select: { jobs: true } } },
  });
  if (!group) return;

  // Work already done under this group's name would lose it. Retiring keeps
  // the history readable, so that is what a used group gets instead.
  if (group._count.jobs > 0) {
    await prisma.group.update({
      where: { id: group.id },
      data: { isActive: false },
    });
    revalidatePath("/team/groups");
    revalidatePath(`/team/groups/${group.id}`);
    return;
  }

  await prisma.group.delete({ where: { id: group.id } });

  revalidatePath("/team/groups");
  redirect("/team/groups");
}
