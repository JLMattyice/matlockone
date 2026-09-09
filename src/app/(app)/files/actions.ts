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
import { isImageMime, putFile, removeFile, statFile } from "@/lib/storage";
import { verifyUploadTicket } from "@/lib/storage/ticket";
import { MAX_UPLOAD_BYTES } from "@/lib/storage-limits";

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
 * The counterpart to /api/files/upload-ticket. By the time this runs the bytes
 * are already in the store and the server never saw them, so everything here is
 * about not taking the client's word for what happened:
 *
 *   - the ticket's signature proves the server chose this key, for this
 *     organization, against this record;
 *   - the organization on the ticket must still be the caller's, so a ticket
 *     cannot be replayed by a different session;
 *   - the object is re-read from the store, so the recorded size is the size on
 *     disk rather than the size that was promised.
 *
 * A ticket that fails any of these is skipped rather than fatal: one bad file in
 * a batch of ten should not discard the nine that were fine.
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
    const ticket = typeof raw === "string" ? verifyUploadTicket(raw) : null;
    if (!ticket) {
      problems.push("An upload could not be verified.");
      continue;
    }

    // A valid signature from another tenant is still not this caller's to file.
    if (ticket.organizationId !== org.id) {
      problems.push("An upload could not be verified.");
      continue;
    }

    if (!(await attachmentTargetExists(ticket.entityType, ticket.entityId, org.id))) {
      problems.push("That record no longer exists.");
      continue;
    }

    // The object itself is the authority on what was uploaded.
    const object = await statFile(ticket.key);
    if (!object) {
      problems.push(`${ticket.originalName}: the upload did not finish.`);
      continue;
    }
    if (object.sizeBytes === 0) {
      problems.push(`${ticket.originalName}: that file is empty.`);
      await removeFile(ticket.key);
      continue;
    }
    if (object.sizeBytes > MAX_UPLOAD_BYTES) {
      // The presigned URL was issued with a size limit, but a store that does
      // not enforce one must not become a way past the application's.
      problems.push(
        `${ticket.originalName}: files must be under ${Math.round(
          MAX_UPLOAD_BYTES / 1024 / 1024,
        )} MB.`,
      );
      await removeFile(ticket.key);
      continue;
    }

    const resolvedKind: AttachmentKind =
      kind === "DOCUMENT" && isImageMime(ticket.mimeType) ? "PHOTO" : kind;

    await prisma.attachment.create({
      data: {
        organizationId: org.id,
        kind: resolvedKind,
        photoStage: resolvedKind === "PHOTO" ? photoStage : null,
        fileName: ticket.key.split("/").pop()!,
        originalName: ticket.originalName,
        mimeType: ticket.mimeType,
        sizeBytes: object.sizeBytes,
        storagePath: ticket.key,
        caption,
        uploadedById: user.id,
        [ATTACHMENT_ENTITIES[ticket.entityType].column]: ticket.entityId,
      },
    });

    entityType = ticket.entityType;
    entityId = ticket.entityId;
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
