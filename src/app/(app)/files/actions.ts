"use server";

import { revalidatePath } from "next/cache";

import { failed, saved, text, type ActionState } from "@/lib/action-state";
import {
  ATTACHMENT_ENTITIES,
  isAttachmentEntityType,
  type AttachmentEntityType,
} from "@/lib/attachment-entities";
import { requirePermission } from "@/lib/auth";
import {
  ATTACHMENT_KINDS,
  PHOTO_STAGES,
  type AttachmentKind,
} from "@/lib/constants";
import { prisma } from "@/lib/db";
import { isImageMime, putFile, removeFile } from "@/lib/storage";

/**
 * The Prisma model behind each attachment target.
 *
 * A lookup rather than a chain of ternaries: the old chain ended in an `else`
 * that reached for invoices, so adding a sixth entity type silently checked
 * the wrong table and every upload against it was rejected as missing. Keying
 * the type to the model means a new entry has to name its own table.
 */
const ATTACHMENT_TARGET_MODELS: Record<
  AttachmentEntityType,
  { findFirst(args: { where: object; select: object }): Promise<unknown> }
> = {
  client: prisma.client,
  job: prisma.job,
  lead: prisma.lead,
  estimate: prisma.estimate,
  invoice: prisma.invoice,
  expense: prisma.expense,
};

/**
 * Confirms the record a file is being attached to lives in the caller's
 * organization. Without this an id from another tenant would hang a file off a
 * record the uploader cannot see.
 */
async function targetExists(
  entityType: AttachmentEntityType,
  entityId: string,
  organizationId: string,
) {
  const found = await ATTACHMENT_TARGET_MODELS[entityType].findFirst({
    where: { id: entityId, organizationId },
    select: { id: true },
  });

  return Boolean(found);
}

export async function uploadAttachment(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { user, org } = await requirePermission("files:write");

  const entityType = formData.get("entityType");
  const entityId = String(formData.get("entityId") ?? "");

  if (!isAttachmentEntityType(entityType) || !entityId) {
    return failed("Unknown record.");
  }
  if (!(await targetExists(entityType, entityId, org.id))) {
    return failed("That record no longer exists.");
  }

  const files = formData
    .getAll("files")
    .filter((value): value is File => value instanceof File && value.size > 0);

  if (files.length === 0) return failed("Choose a file to upload.");
  if (files.length > 10) return failed("Upload at most 10 files at a time.");

  const requestedKind = String(formData.get("kind") ?? "DOCUMENT");
  const kind: AttachmentKind = ATTACHMENT_KINDS.includes(
    requestedKind as AttachmentKind,
  )
    ? (requestedKind as AttachmentKind)
    : "DOCUMENT";

  const stageRaw = text(formData, "photoStage");
  const photoStage =
    stageRaw && PHOTO_STAGES.includes(stageRaw as (typeof PHOTO_STAGES)[number])
      ? stageRaw
      : null;

  const caption = text(formData, "caption");

  let stored = 0;
  const problems: string[] = [];

  for (const file of files) {
    const result = await putFile(org.id, file);

    if (!result.ok) {
      problems.push(`${file.name}: ${result.error}`);
      continue;
    }

    // An image uploaded as a "document" is still a photo; classify by what it
    // actually is so the gallery does not miss it.
    const resolvedKind: AttachmentKind =
      kind === "DOCUMENT" && isImageMime(result.file.mimeType)
        ? "PHOTO"
        : kind;

    await prisma.attachment.create({
      data: {
        organizationId: org.id,
        kind: resolvedKind,
        photoStage: resolvedKind === "PHOTO" ? photoStage : null,
        fileName: result.file.fileName,
        originalName: result.file.originalName,
        mimeType: result.file.mimeType,
        sizeBytes: result.file.sizeBytes,
        storagePath: result.file.storagePath,
        caption,
        uploadedById: user.id,
        [ATTACHMENT_ENTITIES[entityType].column]: entityId,
      },
    });

    stored++;
  }

  revalidatePath(ATTACHMENT_ENTITIES[entityType].path(entityId));
  revalidatePath("/files");

  if (stored === 0) {
    return failed(problems[0] ?? "Nothing was uploaded.");
  }

  return saved(
    problems.length
      ? `Uploaded ${stored}. ${problems.length} skipped — ${problems[0]}`
      : `Uploaded ${stored} file${stored === 1 ? "" : "s"}.`,
  );
}

export async function deleteAttachment(formData: FormData) {
  const { org } = await requirePermission("files:write");

  const id = String(formData.get("id") ?? "");
  const entityType = formData.get("entityType");
  const entityId = String(formData.get("entityId") ?? "");
  if (!id) return;

  const attachment = await prisma.attachment.findFirst({
    where: { id, organizationId: org.id },
    select: { id: true, storagePath: true },
  });
  if (!attachment) return;

  // Row first: an orphaned file on disk is harmless, a row pointing at a
  // missing file is a broken link in the UI.
  await prisma.attachment.delete({ where: { id: attachment.id } });
  await removeFile(attachment.storagePath);

  if (isAttachmentEntityType(entityType) && entityId) {
    revalidatePath(ATTACHMENT_ENTITIES[entityType].path(entityId));
  }
  revalidatePath("/files");
}

export async function updateAttachment(formData: FormData) {
  const { org } = await requirePermission("files:write");

  const id = String(formData.get("id") ?? "");
  const entityType = formData.get("entityType");
  const entityId = String(formData.get("entityId") ?? "");
  if (!id) return;

  const stageRaw = text(formData, "photoStage");
  const photoStage =
    stageRaw && PHOTO_STAGES.includes(stageRaw as (typeof PHOTO_STAGES)[number])
      ? stageRaw
      : null;

  await prisma.attachment.updateMany({
    where: { id, organizationId: org.id },
    data: {
      caption: text(formData, "caption"),
      photoStage,
    },
  });

  if (isAttachmentEntityType(entityType) && entityId) {
    revalidatePath(ATTACHMENT_ENTITIES[entityType].path(entityId));
  }
  revalidatePath("/files");
}
