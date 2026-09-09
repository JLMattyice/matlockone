import { createHash, randomUUID } from "node:crypto";

import { extensionFor } from "./mime";

/**
 * Where a file lives, expressed as a storage key.
 *
 * The key is always generated here and never taken from the uploader. A name
 * that arrived over the wire is kept only as a display label, so "../../.env"
 * cannot become a write target — on a disk, or as an object key in a bucket
 * where the same trick escapes the tenant's prefix.
 *
 * Keys are POSIX-style (`<organizationId>/<uuid>.<ext>`) on every provider,
 * including Windows. Object stores have no other notion of a path, and a key
 * written with a backslash on a desktop install would be unreadable if that
 * business later moved to the hosted product.
 */

/** `<organizationId>/<uuid>.<ext>` */
export function newStorageKey(organizationId: string, mimeType: string) {
  const extension = extensionFor(mimeType);
  if (!extension) return null;

  return `${tenantPrefix(organizationId)}/${randomUUID()}.${extension}`;
}

/**
 * The per-tenant key prefix.
 *
 * Hashed rather than dropped when an id contains anything unexpected: an empty
 * prefix would place one organization's files at the bucket root, where the
 * next organization's traversal check has nothing to catch.
 */
export function tenantPrefix(organizationId: string) {
  const cleaned = organizationId.replace(/[^a-zA-Z0-9_-]/g, "");
  return cleaned || createHash("sha256").update(organizationId).digest("hex").slice(0, 16);
}

/**
 * Rejects a key that could escape its prefix.
 *
 * Keys come from our own database, so this is a last line of defence for a bad
 * row rather than routine input validation — but it runs on every read and
 * delete, because that is exactly the path a bad row would travel.
 */
export function isSafeKey(key: string) {
  if (!key || key.length > 400) return false;
  if (key.startsWith("/") || key.includes("\\")) return false;
  if (key.includes("\0")) return false;

  const segments = key.split("/");
  if (segments.length !== 2) return false;

  return segments.every(
    (segment) => segment.length > 0 && segment !== "." && segment !== "..",
  );
}

/** Keeps the display name readable without letting it reach a filesystem. */
export function cleanName(name: string) {
  return (
    name
      .replace(/[\r\n\t]/g, " ")
      .split(/[\/]/)
      .pop()
      ?.slice(0, 200) || "file"
  );
}
