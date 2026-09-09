import "server-only";

import { assertUsable, storageProviderId } from "./select";

export {
  assertUsable,
  storageProviderId,
  type StorageEnv,
  type StorageProviderId,
} from "./select";

import type { StorageEnv, StorageProviderId } from "./select";

/**
 * The seam every file store plugs into.
 *
 * Three operations, deliberately narrow — the same shape the payment and email
 * seams take, and for the same reason: a provider that only has to answer three
 * questions can be swapped without the application noticing.
 *
 *   put     — hold these bytes under this key
 *   get     — give them back
 *   remove  — forget them
 *
 * Matlock One ships hosted and on the desktop, so there will always be at least
 * two of these. The desktop writes to a folder under the customer's own AppData;
 * a hosted deployment cannot, because a serverless filesystem is read-only and
 * does not survive the request that wrote to it.
 *
 * Choosing the provider lives in ./select, which imports nothing from Node —
 * the boot-time config check needs that answer from an Edge bundle, and getting
 * it from here would pull `node:fs` in behind it.
 */

/**
 * A URL the browser can send bytes straight to.
 *
 * This exists because of a hard limit rather than a preference. A hosted
 * deployment runs the upload through a serverless function, and Vercel caps a
 * function's request body at 4.5MB — while the application allows 15MB, and a
 * photo taken on a phone routinely lands between the two. Proxying the bytes
 * cannot be made to work; the bytes have to skip the server entirely.
 */
export type PresignedUpload = {
  url: string;
  method: "PUT";
  /** Must be sent verbatim: they are covered by the signature. */
  headers: Record<string, string>;
  /** When the URL stops working, so the client can fail clearly rather than late. */
  expiresAt: number;
};

/** What the store actually holds, as opposed to what the client claimed. */
export type StoredObject = {
  sizeBytes: number;
  mimeType: string | null;
};

export type StorageAdapter = {
  id: StorageProviderId;
  /** Named in error messages, so a misconfiguration says which store it meant. */
  label: string;
  put(key: string, body: Uint8Array, mimeType: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  remove(key: string): Promise<void>;

  /**
   * Authorises a direct browser upload, or returns null when this store cannot.
   *
   * Local disk cannot and does not need to: a desktop install talks to a server
   * on the same machine, where no request body limit applies.
   */
  presignUpload?(
    key: string,
    mimeType: string,
    maxBytes: number,
  ): Promise<PresignedUpload | null>;

  /**
   * Reports what was actually stored under a key.
   *
   * The confirm step needs this. Once the browser uploads on its own, the size
   * and type the server recorded are claims the client made before the upload —
   * this is how they get checked against the object that now exists.
   */
  stat?(key: string): Promise<StoredObject | null>;
};

/**
 * Builds the adapter for this deployment.
 *
 * Cloud adapters are imported lazily so a desktop install never loads an SDK it
 * has no use for, and so a missing optional dependency is an error only for the
 * deployment that actually asked for that provider.
 */
export async function storageAdapter(
  env: StorageEnv = process.env,
): Promise<StorageAdapter> {
  const provider = storageProviderId(env);
  assertUsable(provider, env);

  switch (provider) {
    case "s3": {
      const { s3Adapter } = await import("./s3");
      return s3Adapter(env);
    }
    case "vercel-blob": {
      const { vercelBlobAdapter } = await import("./blob");
      return vercelBlobAdapter(env);
    }
    case "local": {
      const { localAdapter } = await import("./local");
      return localAdapter(env);
    }
  }
}
