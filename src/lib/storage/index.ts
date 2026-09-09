import "server-only";

import {
  allowedExtensionsLabel,
  isImageMime,
  MAX_UPLOAD_BYTES,
} from "../storage-limits";
import { cleanName, isSafeKey, newStorageKey } from "./keys";
import { isAllowedMime } from "./mime";
import { storageAdapter, type StorageAdapter } from "./providers";

export { allowedExtensionsLabel, isImageMime, MAX_UPLOAD_BYTES, isAllowedMime };
export { storageProviderId } from "./providers";
export type { StorageAdapter, StorageProviderId } from "./providers";

/**
 * File storage, behind three functions.
 *
 * Which store is underneath is decided by the environment and settled in
 * providers.ts — a folder on the customer's own machine for a desktop install,
 * an object store for a hosted one. Nothing above this line knows the
 * difference, which is what made moving to the cloud a change to this directory
 * rather than to every screen that shows a photo.
 */

export type StoredFile = {
  /** The key the bytes live under. Generated here, never from the uploader. */
  storagePath: string;
  fileName: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
};

export type PutResult =
  | { ok: true; file: StoredFile }
  | { ok: false; error: string };

/**
 * Built once and reused.
 *
 * The promise is cached rather than the adapter, so concurrent first requests
 * share one construction instead of racing to open several connection pools —
 * and a provider that throws on a missing credential does so once per process
 * rather than being retried on every upload.
 */
let adapterPromise: Promise<StorageAdapter> | null = null;

function adapter() {
  adapterPromise ??= storageAdapter();
  return adapterPromise;
}

/** Testing seam: forces the next call to re-read the environment. */
export function resetStorageAdapter() {
  adapterPromise = null;
}

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

  if (!isAllowedMime(file.type)) {
    return {
      ok: false,
      error: `That file type is not supported. Allowed: ${allowedExtensionsLabel()}.`,
    };
  }

  const storagePath = newStorageKey(organizationId, file.type);
  if (!storagePath) {
    return {
      ok: false,
      error: `That file type is not supported. Allowed: ${allowedExtensionsLabel()}.`,
    };
  }

  const store = await adapter();
  await store.put(
    storagePath,
    new Uint8Array(await file.arrayBuffer()),
    file.type,
  );

  return {
    ok: true,
    file: {
      storagePath,
      fileName: storagePath.split("/").pop()!,
      originalName: cleanName(file.name),
      mimeType: file.type,
      sizeBytes: file.size,
    },
  };
}

export async function readFile(storagePath: string) {
  if (!isSafeKey(storagePath)) return null;

  const store = await adapter();
  return store.get(storagePath);
}

export async function removeFile(storagePath: string) {
  if (!isSafeKey(storagePath)) return;

  const store = await adapter();
  await store.remove(storagePath);
}

/**
 * What the store actually holds under a key, or null if nothing does.
 *
 * The direct-upload path needs this. When the browser sends bytes straight to
 * the store, the server never sees them — so the size recorded against the file
 * would otherwise be whatever the client said it would upload, which is not the
 * same thing as what it did upload.
 */
export async function statFile(storagePath: string) {
  if (!isSafeKey(storagePath)) return null;

  const store = await adapter();
  return (await store.stat?.(storagePath)) ?? null;
}

/**
 * Whether this deployment can hand uploads straight to the browser.
 *
 * False on local disk, which is correct rather than a shortfall: a desktop
 * install has no request body limit to work around.
 */
export async function supportsDirectUpload() {
  const store = await adapter();
  return typeof store.presignUpload === "function";
}
