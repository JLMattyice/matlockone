import "server-only";

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  allowedExtensionsLabel,
  isImageMime,
  MAX_UPLOAD_BYTES,
} from "./storage-limits";

export { allowedExtensionsLabel, isImageMime, MAX_UPLOAD_BYTES };

/**
 * File storage behind a narrow interface.
 *
 * The local adapter writes under STORAGE_DIR; swapping in S3 or R2 means
 * reimplementing `putFile`, `readFile` and `removeFile` and nothing else.
 *
 * Storage paths are always generated here from a random UUID and never taken
 * from the uploader. A filename that arrived over the wire is kept only as a
 * display label, so "../../.env" cannot become a write target.
 */

const ALLOWED_MIME = new Map<string, string>([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
  ["image/gif", "gif"],
  ["image/heic", "heic"],
  ["application/pdf", "pdf"],
  ["text/plain", "txt"],
  ["text/csv", "csv"],
  [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "docx",
  ],
  [
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "xlsx",
  ],
  ["application/msword", "doc"],
  ["application/vnd.ms-excel", "xls"],
]);

export function isAllowedMime(mime: string) {
  return ALLOWED_MIME.has(mime);
}

function storageRoot() {
  return path.resolve(process.env.STORAGE_DIR ?? "./storage");
}

export type StoredFile = {
  storagePath: string;
  fileName: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
};

export type PutResult =
  | { ok: true; file: StoredFile }
  | { ok: false; error: string };

export async function putFile(
  organizationId: string,
  file: File,
): Promise<PutResult> {
  if (file.size === 0) return { ok: false, error: "That file is empty." };
  if (file.size > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      error: `Files must be under ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB.`,
    };
  }

  const extension = ALLOWED_MIME.get(file.type);
  if (!extension) {
    return {
      ok: false,
      error: `That file type is not supported. Allowed: ${allowedExtensionsLabel()}.`,
    };
  }

  // Generated, never derived from the upload. The organization prefix keeps
  // one tenant's files out of another's directory even on disk.
  const fileName = `${randomUUID()}.${extension}`;
  const relativePath = path.posix.join(safeSegment(organizationId), fileName);
  const absolutePath = path.join(storageRoot(), relativePath);

  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, Buffer.from(await file.arrayBuffer()));

  return {
    ok: true,
    file: {
      storagePath: relativePath,
      fileName,
      originalName: cleanName(file.name),
      mimeType: file.type,
      sizeBytes: file.size,
    },
  };
}

export async function readFile(storagePath: string) {
  const absolutePath = resolveWithin(storagePath);
  if (!absolutePath) return null;

  try {
    return await fs.readFile(absolutePath);
  } catch {
    return null;
  }
}

export async function removeFile(storagePath: string) {
  const absolutePath = resolveWithin(storagePath);
  if (!absolutePath) return;

  try {
    await fs.unlink(absolutePath);
  } catch {
    // Already gone. The database row is the record that matters.
  }
}

/**
 * Resolves a stored path and refuses anything that escapes the storage root.
 * Paths come from our own database, but this is the last line of defence if a
 * bad row ever gets in.
 */
function resolveWithin(storagePath: string) {
  const root = storageRoot();
  const absolutePath = path.resolve(root, storagePath);

  const relative = path.relative(root, absolutePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;

  return absolutePath;
}

function safeSegment(value: string) {
  const cleaned = value.replace(/[^a-zA-Z0-9_-]/g, "");
  return cleaned || createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/** Keeps the display name readable without letting it reach the filesystem. */
function cleanName(name: string) {
  return (
    name
      .replace(/[\r\n\t]/g, " ")
      .split(/[\\/]/)
      .pop()
      ?.slice(0, 200) || "file"
  );
}

