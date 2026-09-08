"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { failed, invalid, saved, type ActionState } from "@/lib/action-state";
import { requireContext } from "@/lib/auth";
import { NOTE_VISIBILITIES } from "@/lib/constants";
import { prisma } from "@/lib/db";
import {
  isNoteEntityType,
  NOTE_ENTITIES,
  type NoteEntityType,
} from "@/lib/note-entities";
import { can } from "@/lib/permissions";

/**
 * The Prisma model behind each note target.
 *
 * A lookup rather than a chain of ternaries: the old chain ended in an `else`
 * that reached for invoices, so adding a sixth entity type silently checked
 * the wrong table and every note against it was rejected as missing. Keying
 * the type to the model means a new entry has to name its own table.
 */
const NOTE_TARGET_MODELS: Record<
  NoteEntityType,
  { findFirst(args: { where: object; select: object }): Promise<unknown> }
> = {
  client: prisma.client,
  lead: prisma.lead,
  job: prisma.job,
  estimate: prisma.estimate,
  invoice: prisma.invoice,
  expense: prisma.expense,
};

/**
 * Confirms the target record exists inside the caller's organization before a
 * note is written to it. Without this, an id from another tenant would attach
 * a note to a record the caller cannot see.
 */
async function assertTargetInOrg(
  entityType: NoteEntityType,
  entityId: string,
  organizationId: string,
) {
  const found = await NOTE_TARGET_MODELS[entityType].findFirst({
    where: { id: entityId, organizationId },
    select: { id: true },
  });

  return Boolean(found);
}

/**
 * Notes attach to any of five record types. One set of actions handles them
 * all, keyed by `entityType`, so clients and leads share this today and jobs,
 * estimates and invoices pick it up in later phases without new endpoints.
 */
const noteSchema = z.object({
  entityType: z.string().refine(isNoteEntityType, "Unknown record type."),
  entityId: z.string().min(1),
  body: z.string().trim().min(1, "Write something first.").max(5000),
  visibility: z.enum(NOTE_VISIBILITIES).default("INTERNAL"),
});

export async function addNote(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { user, org } = await requireContext();

  const parsed = noteSchema.safeParse({
    entityType: formData.get("entityType"),
    entityId: formData.get("entityId"),
    body: formData.get("body"),
    visibility: formData.get("visibility") || "INTERNAL",
  });

  if (!parsed.success) return invalid(parsed.error);

  const { entityType, entityId, body, visibility } = parsed.data;
  if (!isNoteEntityType(entityType)) return failed("Unknown record type.");

  if (!(await assertTargetInOrg(entityType, entityId, org.id))) {
    return failed("That record no longer exists.");
  }

  await prisma.note.create({
    data: {
      organizationId: org.id,
      body,
      visibility,
      authorId: user.id,
      [NOTE_ENTITIES[entityType].column]: entityId,
    },
  });

  revalidatePath(NOTE_ENTITIES[entityType].path(entityId));
  return saved("Note added.");
}

export async function deleteNote(formData: FormData) {
  const { user, org } = await requireContext();

  const id = String(formData.get("id") ?? "");
  const entityType = formData.get("entityType");
  const entityId = String(formData.get("entityId") ?? "");
  if (!id || !isNoteEntityType(entityType)) return;

  const note = await prisma.note.findFirst({
    where: { id, organizationId: org.id },
    select: { authorId: true },
  });
  if (!note) return;

  // Authors can remove their own notes; clearing someone else's needs a
  // manager-level role.
  const isAuthor = note.authorId === user.id;
  if (!isAuthor && !can(user, "clients:write")) return;

  await prisma.note.deleteMany({ where: { id, organizationId: org.id } });
  revalidatePath(NOTE_ENTITIES[entityType].path(entityId));
}

export async function toggleNotePin(formData: FormData) {
  const { org } = await requireContext();

  const id = String(formData.get("id") ?? "");
  const entityType = formData.get("entityType");
  const entityId = String(formData.get("entityId") ?? "");
  if (!id || !isNoteEntityType(entityType)) return;

  const note = await prisma.note.findFirst({
    where: { id, organizationId: org.id },
    select: { pinned: true },
  });
  if (!note) return;

  await prisma.note.updateMany({
    where: { id, organizationId: org.id },
    data: { pinned: !note.pinned },
  });

  revalidatePath(NOTE_ENTITIES[entityType].path(entityId));
}
