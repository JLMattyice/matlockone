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
import { attachmentTargetExists } from "@/lib/attachment-targets";
import { isImageMime, putFile, removeFile } from "@/lib/storage";
import { acceptUploadTicket } from "@/lib/storage/accept";

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
  if (!(await attachmentTargetExists(entityType, entityId, org.id))) {
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

/**
 * Records files the browser uploaded directly to the store.
 *
 * The counterpart to /api/files/upload-ticket. What makes a ticket believable
 * is in storage/accept.ts, shared with photos sent in a job thread. A ticket
 * that fails is skipped rather than fatal: one bad file in a batch of ten
 * should not discard the nine that were fine.
 */
export async function confirmUploads(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { user, org } = await requirePermission("files:write");

  let tickets: unknown;
  try {
    tickets = JSON.parse(String(formData.get("tickets") ?? "[]"));
  } catch {
    return failed("Nothing was uploaded.");
  }
  if (!Array.isArray(tickets) || tickets.length === 0) {
    return failed("Nothing was uploaded.");
  }
  if (tickets.length > 10) return failed("Upload at most 10 files at a time.");

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
  let entityType: AttachmentEntityType | null = null;
  let entityId = "";

  for (const raw of tickets) {
    const accepted = await acceptUploadTicket(raw, org.id);
    if (!accepted.ok) {
      problems.push(accepted.problem);
      continue;
    }
    const upload = accepted.upload;

    const resolvedKind: AttachmentKind =
      kind === "DOCUMENT" && isImageMime(upload.mimeType) ? "PHOTO" : kind;

    await prisma.attachment.create({
      data: {
        organizationId: org.id,
        kind: resolvedKind,
        photoStage: resolvedKind === "PHOTO" ? photoStage : null,
        fileName: upload.key.split("/").pop()!,
        originalName: upload.originalName,
        mimeType: upload.mimeType,
        sizeBytes: upload.sizeBytes,
        storagePath: upload.key,
        caption,
        uploadedById: user.id,
        [ATTACHMENT_ENTITIES[upload.entityType].column]: upload.entityId,
      },
    });

    entityType = upload.entityType;
    entityId = upload.entityId;
    stored++;
  }

  if (entityType && entityId) {
    revalidatePath(ATTACHMENT_ENTITIES[entityType].path(entityId));
  }
  revalidatePath("/files");

  if (stored === 0) return failed(problems[0] ?? "Nothing was uploaded.");

  return saved(
    problems.length
      ? `Uploaded ${stored}. ${problems.length} skipped — ${problems[0]}`
      : `Uploaded ${stored} file${stored === 1 ? "" : "s"}.`,
  );
}

/**
 * One entry point for the upload form, whichever way the bytes travelled.
 *
 * The form does not get to choose the code path on the server: it either sends
 * files (desktop, and any store that cannot presign) or it sends tickets for
 * files it has already delivered (hosted). `useActionState` binds a single
 * action, and branching here rather than in the component keeps both paths
 * under the same permission check.
 */
export async function submitUpload(
  prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return formData.get("tickets")
    ? confirmUploads(prev, formData)
    : uploadAttachment(prev, formData);
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
