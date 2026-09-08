"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { failed, invalid, saved, text, type ActionState } from "@/lib/action-state";
import { requirePermission } from "@/lib/auth";
import { LEAD_SOURCES, LEAD_STATUSES, type LeadStatus } from "@/lib/constants";
import { prisma } from "@/lib/db";
import { parseMoneyToCents } from "@/lib/money";

const leadSchema = z.object({
  name: z.string().trim().min(1, "Name is required."),
  businessName: z.string().trim().nullish(),
  email: z.union([z.string().trim().email("Enter a valid email."), z.null()]),
  phone: z.string().trim().nullish(),
  source: z.union([z.enum(LEAD_SOURCES), z.null()]),
  status: z.enum(LEAD_STATUSES),
  estimatedValue: z.string().trim().nullish(),
  assignedToId: z.string().trim().nullish(),
  lostReason: z.string().trim().nullish(),
});

function parseLeadForm(formData: FormData) {
  return leadSchema.safeParse({
    name: formData.get("name"),
    businessName: text(formData, "businessName"),
    email: text(formData, "email"),
    phone: text(formData, "phone"),
    source: text(formData, "source"),
    status: formData.get("status") ?? "NEW",
    estimatedValue: text(formData, "estimatedValue"),
    assignedToId: text(formData, "assignedToId"),
    lostReason: text(formData, "lostReason"),
  });
}

/** An assignee must be an active member of the caller's own organization. */
async function resolveAssignee(
  assignedToId: string | null | undefined,
  organizationId: string,
) {
  if (!assignedToId) return null;
  const user = await prisma.user.findFirst({
    where: { id: assignedToId, organizationId, isActive: true },
    select: { id: true },
  });
  return user?.id ?? null;
}

/**
 * Timestamps that follow from a status change. Kept in one place so a lead
 * moved from the board and one saved from the edit form record the same thing.
 */
function statusTimestamps(status: LeadStatus, previous?: LeadStatus) {
  const now = new Date();
  const patch: {
    lastContactedAt?: Date;
    convertedAt?: Date | null;
  } = {};

  // Moving past NEW means somebody has made contact.
  if (status !== "NEW" && previous === "NEW") patch.lastContactedAt = now;
  if (status === "CONTACTED") patch.lastContactedAt = now;
  if (status !== "WON") patch.convertedAt = null;

  return patch;
}

export async function createLead(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { user, org } = await requirePermission("leads:write");

  const parsed = parseLeadForm(formData);
  if (!parsed.success) return invalid(parsed.error);

  const input = parsed.data;

  const lead = await prisma.lead.create({
    data: {
      organizationId: org.id,
      name: input.name,
      businessName: input.businessName ?? null,
      email: input.email ?? null,
      phone: input.phone ?? null,
      source: input.source ?? null,
      status: input.status,
      estimatedValueCents: parseMoneyToCents(input.estimatedValue ?? null),
      assignedToId: await resolveAssignee(input.assignedToId, org.id),
      lostReason: input.status === "LOST" ? (input.lostReason ?? null) : null,
      createdById: user.id,
      ...statusTimestamps(input.status, "NEW"),
    },
  });

  revalidatePath("/leads");
  redirect(`/leads/${lead.id}`);
}

export async function updateLead(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { org } = await requirePermission("leads:write");

  const id = text(formData, "id");
  if (!id) return failed("Missing lead id.");

  const existing = await prisma.lead.findFirst({
    where: { id, organizationId: org.id },
    select: { status: true },
  });
  if (!existing) return failed("That lead no longer exists.");

  const parsed = parseLeadForm(formData);
  if (!parsed.success) return invalid(parsed.error);

  const input = parsed.data;

  await prisma.lead.update({
    where: { id },
    data: {
      name: input.name,
      businessName: input.businessName ?? null,
      email: input.email ?? null,
      phone: input.phone ?? null,
      source: input.source ?? null,
      status: input.status,
      estimatedValueCents: parseMoneyToCents(input.estimatedValue ?? null),
      assignedToId: await resolveAssignee(input.assignedToId, org.id),
      lostReason: input.status === "LOST" ? (input.lostReason ?? null) : null,
      ...statusTimestamps(input.status, existing.status as LeadStatus),
    },
  });

  revalidatePath("/leads");
  revalidatePath(`/leads/${id}`);
  return saved("Lead updated.");
}

export async function setLeadStatus(formData: FormData) {
  const { org } = await requirePermission("leads:write");

  const id = String(formData.get("id") ?? "");
  const status = String(formData.get("status") ?? "");
  if (!id || !LEAD_STATUSES.includes(status as LeadStatus)) return;

  const existing = await prisma.lead.findFirst({
    where: { id, organizationId: org.id },
    select: { status: true },
  });
  if (!existing) return;

  await prisma.lead.update({
    where: { id },
    data: {
      status,
      lostReason: status === "LOST" ? undefined : null,
      ...statusTimestamps(status as LeadStatus, existing.status as LeadStatus),
    },
  });

  revalidatePath("/leads");
  revalidatePath(`/leads/${id}`);
}

export async function logLeadContact(formData: FormData) {
  const { org } = await requirePermission("leads:write");

  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const lead = await prisma.lead.findFirst({
    where: { id, organizationId: org.id },
    select: { status: true },
  });
  if (!lead) return;

  await prisma.lead.update({
    where: { id },
    data: {
      lastContactedAt: new Date(),
      // Logging a call on an untouched lead moves it out of New on its own.
      status: lead.status === "NEW" ? "CONTACTED" : lead.status,
    },
  });

  revalidatePath("/leads");
  revalidatePath(`/leads/${id}`);
}

/**
 * Turns a won lead into a client record.
 *
 * The lead is kept and linked rather than deleted, so the pipeline history and
 * the source attribution survive. Re-running on an already-converted lead is a
 * no-op that returns the existing client.
 */
export async function convertLeadToClient(formData: FormData) {
  const { user, org } = await requirePermission("leads:write");
  await requirePermission("clients:write");

  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const lead = await prisma.lead.findFirst({
    where: { id, organizationId: org.id },
  });
  if (!lead) return;

  if (lead.clientId) redirect(`/clients/${lead.clientId}`);

  const isBusiness = Boolean(lead.businessName);
  const [firstName, ...rest] = lead.name.trim().split(/\s+/);

  const client = await prisma.$transaction(async (tx) => {
    const created = await tx.client.create({
      data: {
        organizationId: org.id,
        type: isBusiness ? "BUSINESS" : "PERSON",
        firstName: firstName ?? null,
        lastName: rest.length ? rest.join(" ") : null,
        businessName: lead.businessName,
        displayName: lead.businessName ?? lead.name,
        email: lead.email,
        phone: lead.phone,
        status: "ACTIVE",
        source: lead.source,
        createdById: user.id,
      },
    });

    await tx.lead.update({
      where: { id: lead.id },
      data: { clientId: created.id, status: "WON", convertedAt: new Date() },
    });

    // Carry the pipeline notes across so context is not stranded on the lead.
    await tx.note.updateMany({
      where: { leadId: lead.id, organizationId: org.id },
      data: { clientId: created.id },
    });

    return created;
  });

  revalidatePath("/leads");
  revalidatePath("/clients");
  redirect(`/clients/${client.id}`);
}

export async function deleteLead(formData: FormData) {
  const { org } = await requirePermission("leads:write");

  const id = String(formData.get("id") ?? "");
  if (!id) return;

  await prisma.lead.deleteMany({ where: { id, organizationId: org.id } });

  revalidatePath("/leads");
  redirect("/leads");
}
