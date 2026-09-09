/**
 * Which file store this deployment uses — decided from the environment alone.
 *
 * Deliberately separate from providers.ts, and deliberately free of both
 * `server-only` and any Node import. The boot-time configuration check needs to
 * answer "which store is this?", and it runs inside instrumentation, which Next
 * compiles for the Edge runtime as well as Node. Reaching this answer through
 * the module that constructs adapters would drag `node:fs` into an Edge bundle
 * and fail the build — which is exactly what it did.
 */

export type StorageProviderId = "local" | "s3" | "vercel-blob";

export type StorageEnv = Record<string, string | undefined>;

const PROVIDER_IDS: StorageProviderId[] = ["local", "s3", "vercel-blob"];

function isProviderId(value: string): value is StorageProviderId {
  return (PROVIDER_IDS as string[]).includes(value);
}

/**
 * An explicit STORAGE_PROVIDER always wins. Otherwise the choice is inferred
 * from which credentials are actually present, which matches how the email and
 * payment settings behave: a half-configured provider is not offered rather
 * than failing at the first use.
 *
 * The last resort is local disk, and on a serverless host that is a mistake
 * rather than a default — see `assertUsable`.
 */
export function storageProviderId(env: StorageEnv = process.env): StorageProviderId {
  const explicit = env.STORAGE_PROVIDER?.trim().toLowerCase();
  if (explicit) {
    if (!isProviderId(explicit)) {
      throw new Error(
        `STORAGE_PROVIDER is "${explicit}", which is not a storage provider.\n` +
          `Expected one of: ${PROVIDER_IDS.join(", ")}.`,
      );
    }
    return explicit;
  }

  if (env.S3_BUCKET?.trim() && env.S3_ACCESS_KEY_ID?.trim()) return "s3";
  if (env.BLOB_READ_WRITE_TOKEN?.trim()) return "vercel-blob";

  return "local";
}

/**
 * Refuses local disk on a host that cannot keep it.
 *
 * On Vercel the filesystem is read-only apart from /tmp, and /tmp belongs to
 * one invocation — a file written there is gone before anyone asks for it back.
 * Without this check the failure is silent and delayed: uploads appear to
 * succeed, and every one of them is a broken link the next time the page loads.
 * Far better to refuse to start.
 */
export function assertUsable(
  provider: StorageProviderId,
  env: StorageEnv = process.env,
) {
  if (provider !== "local") return;

  // Set by Vercel on every deployment, including preview builds.
  if (env.VERCEL) {
    throw new Error(
      "Storage is set to local disk, but this is running on Vercel, whose " +
        "filesystem is read-only and per-invocation.\n" +
        "Uploads would appear to succeed and immediately be lost.\n" +
        "Set STORAGE_PROVIDER=s3 with S3_BUCKET/S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY, " +
        "or STORAGE_PROVIDER=vercel-blob with BLOB_READ_WRITE_TOKEN.",
    );
  }
}
