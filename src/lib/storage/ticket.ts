import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

import type { AttachmentEntityType } from "../attachment-entities";

/**
 * The receipt handed to a browser that is about to upload on its own.
 *
 * Once the bytes skip the server, the server no longer witnesses the upload. It
 * has to be told afterwards which file to record — and everything in that
 * message arrives from the client, which means none of it can be believed
 * without proof.
 *
 * So the server signs what it decided: this key, for this organization, this
 * person, attached to this record. The browser cannot alter any of it, because
 * changing a byte invalidates the signature. What it *can* still lie about is
 * the file it actually uploaded, which is why the confirm step re-reads the
 * object's real size from the store rather than trusting `sizeBytes` here.
 *
 * The tenancy fields are the ones that matter most: without a signature over
 * `organizationId`, a confirm call could file another business's upload into
 * its own records, or its own upload into theirs.
 */

export type UploadTicket = {
  key: string;
  organizationId: string;
  userId: string;
  entityType: AttachmentEntityType;
  entityId: string;
  mimeType: string;
  /** What the client said before uploading. Verified against the store later. */
  sizeBytes: number;
  originalName: string;
  expiresAt: number;
};

function secret() {
  const value = process.env.SESSION_SECRET;
  if (!value || value.length < 16) {
    throw new Error(
      "SESSION_SECRET must be set to at least 16 characters. See .env.example.",
    );
  }
  return value;
}

function sign(payload: string) {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

export function signUploadTicket(ticket: UploadTicket) {
  const payload = Buffer.from(JSON.stringify(ticket), "utf8").toString("base64url");
  return `${payload}.${sign(payload)}`;
}

/**
 * Returns the ticket, or null for anything that is not exactly one we issued
 * and that has not expired.
 *
 * Null rather than a thrown error or a reason: a caller that could tell a bad
 * signature from an expired one from a malformed one would be a way to probe
 * how tickets are made.
 */
export function verifyUploadTicket(token: string): UploadTicket | null {
  if (typeof token !== "string") return null;

  const separator = token.lastIndexOf(".");
  if (separator <= 0) return null;

  const payload = token.slice(0, separator);
  const provided = token.slice(separator + 1);

  const expected = sign(payload);

  // Constant-time, and length-checked first because timingSafeEqual throws on
  // a length mismatch rather than returning false.
  const a = Buffer.from(provided, "base64url");
  const b = Buffer.from(expected, "base64url");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let ticket: UploadTicket;
  try {
    ticket = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  if (typeof ticket?.expiresAt !== "number" || ticket.expiresAt < Date.now()) {
    return null;
  }

  return ticket;
}
