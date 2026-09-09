import "server-only";

import fs from "node:fs/promises";
import path from "node:path";

import type { StorageAdapter, StorageEnv } from "./providers";

/**
 * Files on the machine running the server.
 *
 * This is the desktop build's store: the business's photos and documents sit in
 * a folder beside their database, on their own computer, and are backed up by
 * copying that folder. It is also the most convenient store for local
 * development.
 *
 * It is not a hosted option. See `assertUsable` in providers.ts.
 */
export function localAdapter(env: StorageEnv = process.env): StorageAdapter {
  const root = path.resolve(env.STORAGE_DIR ?? "./storage");

  /**
   * Resolves a key under the storage root and refuses anything that escapes it.
   *
   * `isSafeKey` has already rejected traversal by the time a key reaches here.
   * This is the same check expressed against the real filesystem, which is what
   * catches a symlink or a drive-relative path that looks harmless as a string.
   */
  function resolveWithin(key: string) {
    const absolute = path.resolve(root, key);
    const relative = path.relative(root, absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
    return absolute;
  }

  return {
    id: "local",
    label: "local disk",

    async put(key, body) {
      const absolute = resolveWithin(key);
      if (!absolute) throw new Error("Refusing to write outside the storage directory.");

      await fs.mkdir(path.dirname(absolute), { recursive: true });
      await fs.writeFile(absolute, body);
    },

    async get(key) {
      const absolute = resolveWithin(key);
      if (!absolute) return null;

      try {
        return await fs.readFile(absolute);
      } catch {
        return null;
      }
    },

    async remove(key) {
      const absolute = resolveWithin(key);
      if (!absolute) return;

      try {
        await fs.unlink(absolute);
      } catch {
        // Already gone. The database row is the record that matters.
      }
    },

    async stat(key) {
      const absolute = resolveWithin(key);
      if (!absolute) return null;

      try {
        const stats = await fs.stat(absolute);
        // The filesystem does not record a content type; the caller falls back
        // to what it recorded at upload time.
        return { sizeBytes: stats.size, mimeType: null };
      } catch {
        return null;
      }
    },

    // No presignUpload. There is nothing to sign a URL against — and nothing to
    // gain: a desktop install talks to a server on the same machine, where no
    // request body limit applies. Callers fall back to uploading through the
    // server, which is the right path here.
  };
}
