"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { failed, text, type ActionState } from "@/lib/action-state";
import { requirePermission } from "@/lib/auth";
import { MESSAGE_MAX_LENGTH, type MessageView } from "@/lib/chat";
import {
  openDirectConversation,
  postMessage,
  startConversation,
} from "@/lib/conversations";

/**
 * Writes for team messaging.
 *
 * Membership is checked inside every call into `conversations.ts`, so an id
 * posted from somebody else's thread gets the same answer as a made-up one.
 */

export type SendResult =
  | { ok: true; message: MessageView }
  | { ok: false; error: string };

function tooLong(body: string) {
  return body.length > MESSAGE_MAX_LENGTH
    ? `Keep it under ${MESSAGE_MAX_LENGTH.toLocaleString("en-US")} characters.`
    : null;
}

/**
 * Called straight from the composer rather than through a form, so the thread
 * can show the message the moment it is sent and swap in the saved one when
 * this returns.
 */
export async function sendMessage(
  conversationId: unknown,
  body: unknown,
): Promise<SendResult> {
  const { user, org } = await requirePermission("messages:use");

  const text = typeof body === "string" ? body.trim() : "";
  if (typeof conversationId !== "string" || !conversationId) {
    return { ok: false, error: "That conversation is not available." };
  }
  if (!text) return { ok: false, error: "Write something first." };
  const lengthError = tooLong(text);
  if (lengthError) return { ok: false, error: lengthError };

  const message = await postMessage({
    organizationId: org.id,
    conversationId,
    authorId: user.id,
    body: text,
  });
  if (!message) return { ok: false, error: "That conversation is not available." };

  // Re-sorts the inbox beside the thread with this one on top.
  revalidatePath("/messages", "layout");
  return { ok: true, message };
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
    await postMessage({ organizationId: org.id, conversationId: id, authorId: user.id, body });
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
