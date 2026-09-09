import { NextResponse, type NextRequest } from "next/server";

import { attachmentTargetExists } from "@/lib/attachment-targets";
import { isAttachmentEntityType } from "@/lib/attachment-entities";
import { getContext } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { storageAdapter } from "@/lib/storage/providers";
import { newStorageKey } from "@/lib/storage/keys";
import { isAllowedMime } from "@/lib/storage/mime";
import { signUploadTicket } from "@/lib/storage/ticket";
import { allowedExtensionsLabel, MAX_UPLOAD_BYTES } from "@/lib/storage-limits";

/**
 * Authorises one direct browser-to-store upload.
 *
 * The browser sends the bytes itself because it has to: a hosted deployment
 * runs on serverless functions whose request bodies are capped well below the
 * 15MB this application allows, and a photo from a phone lands between the two.
 *
 * Everything that decides *where* the file may go is settled here, on the
 * server, and signed — see storage/ticket.ts. The browser is handed a URL that
 * writes to exactly one key, and a receipt it cannot alter.
 *
 * `getContext` rather than `requirePermission`, which redirects: a redirect is
 * the right answer for a page and useless to fetch().
 */
export async function POST(request: NextRequest) {
  const ctx = await getContext();
  if (!ctx || !can(ctx.user, "files:write")) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Malformed request." }, { status: 400 });
  }

  const { entityType, entityId, fileName, mimeType, sizeBytes } = (body ?? {}) as
    Record<string, unknown>;

  if (!isAttachmentEntityType(entityType) || typeof entityId !== "string" || !entityId) {
    return NextResponse.json({ error: "Unknown record." }, { status: 400 });
  }
  if (typeof mimeType !== "string" || typeof fileName !== "string") {
    return NextResponse.json({ error: "Malformed request." }, { status: 400 });
  }
  if (typeof sizeBytes !== "number" || !Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return NextResponse.json({ error: "That file is empty." }, { status: 400 });
  }

  // Checked here as well as at confirm time. This one is a courtesy — it fails
  // the upload before the bytes are sent rather than after.
  if (sizeBytes > MAX_UPLOAD_BYTES) {
    return NextResponse.json(
      {
        error: `Files must be under ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB.`,
      },
      { status: 400 },
    );
  }
  if (!isAllowedMime(mimeType)) {
    return NextResponse.json(
      { error: `That file type is not supported. Allowed: ${allowedExtensionsLabel()}.` },
      { status: 400 },
    );
  }

  // The tenant boundary. An id from another organization must not become a
  // place to hang a file, and the answer is the same 404 a missing record gets.
  if (!(await attachmentTargetExists(entityType, entityId, ctx.org.id))) {
    return NextResponse.json({ error: "That record no longer exists." }, { status: 404 });
  }

  const key = newStorageKey(ctx.org.id, mimeType);
  if (!key) {
    return NextResponse.json(
      { error: `That file type is not supported. Allowed: ${allowedExtensionsLabel()}.` },
      { status: 400 },
    );
  }

  const store = await storageAdapter();
  const upload = await store.presignUpload?.(key, mimeType, MAX_UPLOAD_BYTES);

  // Local disk cannot presign and does not need to — a desktop install talks to
  // a server on its own machine. Saying so plainly lets the browser fall back to
  // uploading through the server rather than failing.
  if (!upload) {
    return NextResponse.json({ direct: false as const });
  }

  return NextResponse.json({
    direct: true as const,
    upload,
    ticket: signUploadTicket({
      key,
      organizationId: ctx.org.id,
      userId: ctx.user.id,
      entityType,
      entityId,
      mimeType,
      sizeBytes,
      originalName: fileName,
      expiresAt: upload.expiresAt,
    }),
  });
}
