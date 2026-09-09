import "server-only";

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import type { StorageAdapter, StorageEnv } from "./providers";

/**
 * Any S3-compatible object store.
 *
 * Deliberately not tied to AWS. The same adapter serves Cloudflare R2, Amazon
 * S3, Backblaze B2, Supabase Storage and a self-hosted MinIO, because they all
 * speak the same protocol and the difference is an endpoint. That matters for
 * the same reason it matters with payment processors: a business's photos and
 * signed documents are theirs, and the software should never be the reason
 * those can only live in one company's bucket.
 *
 * Objects are written with no ACL, so they inherit the bucket's own policy. The
 * bucket must be private — every read goes through /api/files/[id], which
 * checks the session and the tenant first. A public bucket would make that
 * check decorative.
 */

function required(env: StorageEnv, name: string) {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(
      `Storage is set to S3, but ${name} is not set.\n` +
        "Required: S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY.\n" +
        "Set S3_ENDPOINT too for R2, Supabase, Backblaze or MinIO.",
    );
  }
  return value;
}

export function s3Adapter(env: StorageEnv = process.env): StorageAdapter {
  const bucket = required(env, "S3_BUCKET");
  const endpoint = env.S3_ENDPOINT?.trim();

  const client = new S3Client({
    // R2 and several others ignore the region but require one to be present.
    region: env.S3_REGION?.trim() || "auto",
    ...(endpoint ? { endpoint } : {}),
    // MinIO and some self-hosted stores cannot do virtual-host addressing.
    forcePathStyle: env.S3_FORCE_PATH_STYLE?.trim() === "true",
    credentials: {
      accessKeyId: required(env, "S3_ACCESS_KEY_ID"),
      secretAccessKey: required(env, "S3_SECRET_ACCESS_KEY"),
    },
  });

  return {
    id: "s3",
    label: endpoint ? `S3-compatible store at ${endpoint}` : `S3 bucket ${bucket}`,

    async put(key, body, mimeType) {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: mimeType,
        }),
      );
    },

    async get(key) {
      try {
        const response = await client.send(
          new GetObjectCommand({ Bucket: bucket, Key: key }),
        );
        if (!response.Body) return null;

        return Buffer.from(await response.Body.transformToByteArray());
      } catch (error) {
        // A missing object is a 404 here and a null to the caller, the same as
        // a deleted file on disk. Anything else — credentials, networking, a
        // bucket that does not exist — is a fault worth surfacing, because
        // swallowing it would show every file in the app as missing and give
        // no hint why.
        if (isNotFound(error)) return null;
        throw error;
      }
    },

    async remove(key) {
      try {
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      } catch (error) {
        if (isNotFound(error)) return;
        throw error;
      }
    },

    async presignUpload(key, mimeType) {
      const url = await getSignedUrl(
        client,
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          // Signed in, so the browser cannot upload a script and have it served
          // back later as something else. The client must send exactly this.
          ContentType: mimeType,
        }),
        { expiresIn: PRESIGN_SECONDS },
      );

      return {
        url,
        method: "PUT" as const,
        headers: { "Content-Type": mimeType },
        expiresAt: Date.now() + PRESIGN_SECONDS * 1000,
      };
    },

    async stat(key) {
      try {
        const response = await client.send(
          new HeadObjectCommand({ Bucket: bucket, Key: key }),
        );

        return {
          sizeBytes: response.ContentLength ?? 0,
          mimeType: response.ContentType ?? null,
        };
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
  };
}

/**
 * How long a browser has to start an upload.
 *
 * Long enough for a slow phone connection to get going, short enough that a URL
 * captured from a device's logs is not a lasting way into the bucket.
 */
const PRESIGN_SECONDS = 10 * 60;

function isNotFound(error: unknown) {
  const name = (error as { name?: string })?.name;
  const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata
    ?.httpStatusCode;

  return name === "NoSuchKey" || name === "NotFound" || status === 404;
}
