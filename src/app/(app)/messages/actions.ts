"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { failed, text, type ActionState } from "@/lib/action-state";
import { requirePermission } from "@/lib/auth";
import {
  MAX_PHOTOS_PER_MESSAGE,
  MESSAGE_MAX_LENGTH,
  type MessageView,
} from "@/lib/chat";
import {
  conversationAccessWhere,
  openDirectConversation,
  openJobThread,
  postMessage,
  startConversation,
} from "@/lib/conversations";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { isImageMime, putFile, removeFile } from "@/lib/storage";
import { acceptUploadTicket } from "@/lib/storage/accept";

/**
 * Writes for team messaging.
 *
 * Who may open a thread is decided inside every call into `conversations.ts`,
 * so an id posted from somebody else's thread gets the same answer as a
 * made-up one.
 */

export type SendResult =
  | { ok: true; message: MessageView; warning?: string }
  | { ok: false; error: string };

function tooLong(body: string) {
  return body.length > MESSAGE_MAX_LENGTH
    ? `Keep it under ${MESSAGE_MAX_LENGTH.toLocaleString("en-US")} characters.`
    : null;
}

function readTickets(formData: FormData): unknown[] {
  try {
    const parsed = JSON.parse(String(formData.get("tickets") ?? "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Sends a message, with any photos, from the composer.
 *
 * Called straight from the thread rather than through a form, so the message
 * shows the moment it is sent and the saved one replaces it when this returns.
 *
 * Photos arrive one of two ways, like every other upload: as tickets for files
 * the browser already put in the store (hosted), or as the files themselves
 * (the desktop build, whose store cannot presign). Either way each becomes an
 * ordinary photo on the job before the message is written, so it is in the
 * job's Photos & documents whether or not anybody reads the thread. Photos go
 * only in job threads — a photo in a private conversation would have to be
 * hidden from the job's files and the business's file list, and neither is
 * built for that.
 */
export async function sendMessage(formData: FormData): Promise<SendResult> {
  const { user, org } = await requirePermission("messages:use");

  const conversationId = text(formData, "conversationId");
  const body = String(formData.get("body") ?? "").trim();
  const tickets = readTickets(formData);
  const files = formData
    .getAll("photos")
    .filter((value): value is File => value instanceof File && value.size > 0);
  const photoCount = tickets.length + files.length;

  if (!conversationId) return { ok: false, error: "That conversation is not available." };
  if (!body && photoCount === 0) return { ok: false, error: "Write something first." };
  const lengthError = tooLong(body);
  if (lengthError) return { ok: false, error: lengthError };
  if (photoCount > MAX_PHOTOS_PER_MESSAGE) {
    return { ok: false, error: `Send up to ${MAX_PHOTOS_PER_MESSAGE} photos at a time.` };
  }

  let jobId: string | null = null;
  const photoIds: string[] = [];
  const problems: string[] = [];

  if (photoCount > 0) {
    if (!can(user, "files:write")) {
      return { ok: false, error: "Your role cannot add photos." };
    }

    const thread = await prisma.conversation.findFirst({
      where: { id: conversationId, ...conversationAccessWhere(org.id, user) },
      select: { jobId: true },
    });
    if (!thread) return { ok: false, error: "That conversation is not available." };
    if (!thread.jobId) {
      return { ok: false, error: "Photos can only be sent in a job's conversation." };
    }
    jobId = thread.jobId;

    // The message text, trimmed, is the caption the photo carries on the job.
    const caption = body ? body.slice(0, 200) : null;

    for (const raw of tickets) {
      const accepted = await acceptUploadTicket(raw, org.id);
      if (!accepted.ok) {
        problems.push(accepted.problem);
        continue;
      }
      const upload = accepted.upload;

      // A ticket for some other record, or for a document, is not a photo of
      // this job, however validly it was signed.
      if (upload.entityType !== "job" || upload.entityId !== jobId || !isImageMime(upload.mimeType)) {
        await removeFile(upload.key);
        problems.push(`${upload.originalName} could not be added to this job.`);
        continue;
      }

      const attachment = await prisma.attachment.create({
        data: {
          organizationId: org.id,
          kind: "PHOTO",
          fileName: upload.key.split("/").pop()!,
          originalName: upload.originalName,
          mimeType: upload.mimeType,
          sizeBytes: upload.sizeBytes,
          storagePath: upload.key,
          caption,
          uploadedById: user.id,
          jobId,
        },
        select: { id: true },
      });
      photoIds.push(attachment.id);
    }

    for (const file of files) {
      if (!isImageMime(file.type)) {
        problems.push(`${file.name} is not a photo.`);
        continue;
      }
      const stored = await putFile(org.id, file);
      if (!stored.ok) {
        problems.push(`${file.name}: ${stored.error}`);
        continue;
      }

      const attachment = await prisma.attachment.create({
        data: {
          organizationId: org.id,
          kind: "PHOTO",
          fileName: stored.file.fileName,
          originalName: stored.file.originalName,
          mimeType: stored.file.mimeType,
          sizeBytes: stored.file.sizeBytes,
          storagePath: stored.file.storagePath,
          caption,
          uploadedById: user.id,
          jobId,
        },
        select: { id: true },
      });
      photoIds.push(attachment.id);
    }

    if (photoIds.length === 0 && !body) {
      return { ok: false, error: problems[0] ?? "Those photos could not be sent." };
    }
  }

  const message = await postMessage({
    organizationId: org.id,
    conversationId,
    author: user,
    body,
    photoIds,
  });
  // Photos recorded above stay on the job even if the message itself failed:
  // they were taken on site and are worth keeping without the words.
  if (!message) return { ok: false, error: "That conversation is not available." };

  // Re-sorts the inbox beside the thread with this one on top.
  revalidatePath("/messages", "layout");
  if (jobId) {
    revalidatePath(`/jobs/${jobId}`);
    revalidatePath("/files");
  }

  return problems.length > 0
    ? { ok: true, message, warning: `${problems.length} not sent — ${problems[0]}` }
    : { ok: true, message };
}

export async function startConversationAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { user, org } = await requirePermission("messages:use");

  const memberIds = formData
    .getAll("memberIds")
    .filter((value): value is string => typeof value === "string" && value !== "");
  if (memberIds.length === 0) {
    return { ok: false, fieldErrors: { memberIds: "Pick at least one person." } };
  }

  const body = text(formData, "body");
  const lengthError = body ? tooLong(body) : null;
  if (lengthError) return { ok: false, fieldErrors: { body: lengthError } };

  const id = await startConversation({
    organizationId: org.id,
    userId: user.id,
    memberIds,
    title: text(formData, "title"),
  });
  if (!id) return failed("None of those people can be messaged any more.");

  if (body) {
    await postMessage({ organizationId: org.id, conversationId: id, author: user, body });
  }

  revalidatePath("/messages", "layout");
  redirect(`/messages/${id}`);
}

/** The "Message" button on a teammate's page. */
export async function openDirectMessage(formData: FormData) {
  const { user, org } = await requirePermission("messages:use");

  const id = await openDirectConversation({
    organizationId: org.id,
    userId: user.id,
    otherUserId: String(formData.get("userId") ?? ""),
  });

  revalidatePath("/messages", "layout");
  redirect(id ? `/messages/${id}` : "/messages");
}

/** The "Chat" button on a job: its thread, started if it has none yet. */
export async function openJobChat(formData: FormData) {
  const { user, org } = await requirePermission("messages:use");

  const jobId = String(formData.get("jobId") ?? "");
  const id = await openJobThread({ organizationId: org.id, viewer: user, jobId });

  revalidatePath("/messages", "layout");
  if (jobId) revalidatePath(`/jobs/${jobId}`);
  redirect(id ? `/messages/${id}` : "/messages");
}
