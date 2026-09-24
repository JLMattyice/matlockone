import "server-only";

import type { AttachmentEntityType } from "../attachment-entities";
import { attachmentTargetExists } from "../attachment-targets";
import { MAX_UPLOAD_BYTES } from "../storage-limits";
import { removeFile, statFile } from "./index";
import { verifyUploadTicket } from "./ticket";

/**
 * Accepts one file the browser uploaded straight to the store.
 *
 * By the time this runs the bytes are in the store and the server never saw
 * them, so everything here is about not taking the client's word for what
 * happened:
 *
 *   - the ticket's signature proves the server chose this key, for this
 *     organization, against this record;
 *   - the organization on the ticket must still be the caller's, so a ticket
 *     cannot be replayed by a different session;
 *   - the object is re-read from the store, so the recorded size is the size on
 *     disk rather than the size that was promised.
 *
 * Shared by the upload form and by photos sent in a job thread, because a
 * check that exists on only one of the two ways in is not a check. A rejected
 * object that did reach the store is removed from it.
 */

export type AcceptedUpload = {
  key: string;
  originalName: string;
  mimeType: string;
  /** From the store, not from the ticket. */
  sizeBytes: number;
  entityType: AttachmentEntityType;
  entityId: string;
};

export type AcceptResult =
  | { ok: true; upload: AcceptedUpload }
  | { ok: false; problem: string };

export async function acceptUploadTicket(
  raw: unknown,
  organizationId: string,
): Promise<AcceptResult> {
  const ticket = typeof raw === "string" ? verifyUploadTicket(raw) : null;
  if (!ticket) return { ok: false, problem: "An upload could not be verified." };

  // A valid signature from another tenant is still not this caller's to file.
  if (ticket.organizationId !== organizationId) {
    return { ok: false, problem: "An upload could not be verified." };
  }

  if (!(await attachmentTargetExists(ticket.entityType, ticket.entityId, organizationId))) {
    return { ok: false, problem: "That record no longer exists." };
  }

  // The object itself is the authority on what was uploaded.
  const object = await statFile(ticket.key);
  if (!object) {
    return { ok: false, problem: `${ticket.originalName}: the upload did not finish.` };
  }
  if (object.sizeBytes === 0) {
    await removeFile(ticket.key);
    return { ok: false, problem: `${ticket.originalName}: that file is empty.` };
  }
  if (object.sizeBytes > MAX_UPLOAD_BYTES) {
    // The presigned URL was issued with a size limit, but a store that does
    // not enforce one must not become a way past the application's.
    await removeFile(ticket.key);
    return {
      ok: false,
      problem: `${ticket.originalName}: files must be under ${Math.round(
        MAX_UPLOAD_BYTES / 1024 / 1024,
      )} MB.`,
    };
  }

  return {
    ok: true,
    upload: {
      key: ticket.key,
      originalName: ticket.originalName,
      mimeType: ticket.mimeType,
      sizeBytes: object.sizeBytes,
      entityType: ticket.entityType,
      entityId: ticket.entityId,
    },
  };
}
