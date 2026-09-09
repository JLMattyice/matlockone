import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isSafeKey, newStorageKey, tenantPrefix } from "@/lib/storage/keys";
import { assertUsable, storageProviderId } from "@/lib/storage/providers";
import {
  putFile,
  readFile,
  removeFile,
  resetStorageAdapter,
  statFile,
  supportsDirectUpload,
} from "@/lib/storage";

/**
 * File storage moved from "a folder on this computer" to "whichever store this
 * deployment was pointed at". These cover the parts of that move which are not
 * visible until something has already gone wrong: where a file is allowed to
 * land, and which store gets chosen.
 */

describe("storageProviderId", () => {
  it("honours an explicit setting", () => {
    expect(storageProviderId({ STORAGE_PROVIDER: "s3" })).toBe("s3");
    expect(storageProviderId({ STORAGE_PROVIDER: "  VERCEL-BLOB " })).toBe(
      "vercel-blob",
    );
  });

  it("infers S3 from credentials being present", () => {
    expect(
      storageProviderId({ S3_BUCKET: "files", S3_ACCESS_KEY_ID: "AKIA..." }),
    ).toBe("s3");
  });

  it("does not infer S3 from a half-configured store", () => {
    // Matches how the email and payment settings behave: a provider missing
    // half its credentials is not offered, rather than failing at first use.
    expect(storageProviderId({ S3_BUCKET: "files" })).toBe("local");
  });

  it("infers Vercel Blob from its token", () => {
    expect(storageProviderId({ BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_x" })).toBe(
      "vercel-blob",
    );
  });

  it("falls back to local disk", () => {
    expect(storageProviderId({})).toBe("local");
  });

  it("rejects a provider name it does not recognise", () => {
    expect(() => storageProviderId({ STORAGE_PROVIDER: "dropbox" })).toThrow(
      /not a storage provider/i,
    );
  });
});

describe("assertUsable", () => {
  it("refuses local disk on Vercel", () => {
    // The failure this prevents is silent: uploads appear to succeed, and every
    // one of them is a broken link by the next request.
    expect(() => assertUsable("local", { VERCEL: "1" })).toThrow(/read-only/i);
  });

  it("allows local disk anywhere else", () => {
    expect(() => assertUsable("local", {})).not.toThrow();
  });

  it("does not object to a cloud provider on Vercel", () => {
    expect(() => assertUsable("s3", { VERCEL: "1" })).not.toThrow();
  });
});

describe("storage keys", () => {
  it("puts every file under its organization", () => {
    const key = newStorageKey("org_abc123", "image/jpeg");
    expect(key).toMatch(/^org_abc123\/[0-9a-f-]{36}\.jpg$/);
  });

  it("takes the extension from the content type, not the filename", () => {
    expect(newStorageKey("org1", "application/pdf")).toMatch(/\.pdf$/);
    expect(newStorageKey("org1", "image/png")).toMatch(/\.png$/);
  });

  it("refuses a type that is not allowed", () => {
    expect(newStorageKey("org1", "application/x-msdownload")).toBeNull();
  });

  it("never leaves a tenant prefix empty", () => {
    // An id of only punctuation would otherwise place that organization's files
    // at the bucket root, where the traversal check has nothing to compare to.
    const prefix = tenantPrefix("../..");
    expect(prefix).not.toBe("");
    expect(prefix).not.toContain(".");
    expect(prefix).not.toContain("/");
  });

  it("rejects keys that try to climb out", () => {
    expect(isSafeKey("org1/file.jpg")).toBe(true);

    expect(isSafeKey("../secrets.env")).toBe(false);
    expect(isSafeKey("org1/../../secrets.env")).toBe(false);
    expect(isSafeKey("/etc/passwd")).toBe(false);
    expect(isSafeKey("org1\file.jpg")).toBe(false);
    expect(isSafeKey("")).toBe(false);
    expect(isSafeKey("org1/")).toBe(false);
    expect(isSafeKey("nested/too/deep.jpg")).toBe(false);
  });
});

describe("putFile / readFile / removeFile on local disk", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "storage-"));
    process.env.STORAGE_DIR = dir;
    delete process.env.STORAGE_PROVIDER;
    delete process.env.VERCEL;
    resetStorageAdapter();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.STORAGE_DIR;
    resetStorageAdapter();
  });

  function upload(name: string, type: string, body = "hello") {
    return new File([body], name, { type });
  }

  it("stores bytes and reads them back", async () => {
    const result = await putFile("org1", upload("photo.jpg", "image/jpeg"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.file.storagePath.startsWith("org1/")).toBe(true);
    expect(result.file.originalName).toBe("photo.jpg");

    const bytes = await readFile(result.file.storagePath);
    expect(bytes?.toString()).toBe("hello");
  });

  it("keeps the uploaded name only as a label", async () => {
    // The name reaches the database as a display string; it must never reach
    // the filesystem.
    const result = await putFile(
      "org1",
      upload("../../.env", "image/jpeg"),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.file.originalName).toBe(".env");
    expect(result.file.storagePath).toMatch(/^org1\/[0-9a-f-]{36}\.jpg$/);
    expect(fs.existsSync(path.join(dir, "org1"))).toBe(true);
  });

  it("removes a file", async () => {
    const result = await putFile("org1", upload("a.png", "image/png"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    await removeFile(result.file.storagePath);
    expect(await readFile(result.file.storagePath)).toBeNull();
  });

  it("is untroubled by removing something already gone", async () => {
    await expect(removeFile("org1/missing.jpg")).resolves.toBeUndefined();
  });

  it("refuses an unsupported type", async () => {
    const result = await putFile("org1", upload("run.exe", "application/x-msdownload"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/not supported/i);
  });

  it("refuses an empty file", async () => {
    const result = await putFile("org1", new File([], "empty.jpg", { type: "image/jpeg" }));
    expect(result.ok).toBe(false);
  });

  it("refuses a file over the size limit", async () => {
    const big = new File(["x".repeat(16 * 1024 * 1024)], "big.jpg", {
      type: "image/jpeg",
    });
    const result = await putFile("org1", big);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/under \d+ MB/);
  });

  it("will not read or delete through an unsafe key", async () => {
    fs.writeFileSync(path.join(dir, "secret.txt"), "private");

    expect(await readFile("../secret.txt")).toBeNull();
    await removeFile("../secret.txt");

    // Still there: the traversal was refused rather than followed.
    expect(fs.existsSync(path.join(dir, "secret.txt"))).toBe(true);
  });

  it("reports the size actually stored", async () => {
    // What the confirm step uses instead of the size the client promised.
    const result = await putFile("org1", upload("a.jpg", "image/jpeg", "twelve bytes"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const stat = await statFile(result.file.storagePath);
    expect(stat?.sizeBytes).toBe(12);
  });

  it("reports nothing for a key that was never written", async () => {
    expect(await statFile("org1/missing.jpg")).toBeNull();
  });

  it("will not stat through an unsafe key", async () => {
    expect(await statFile("../secret.txt")).toBeNull();
  });

  it("does not offer direct upload on local disk", async () => {
    // Correct rather than a shortfall: a desktop install talks to a server on
    // the same machine, so there is no request body limit to work around. The
    // upload form falls back to submitting the files themselves.
    expect(await supportsDirectUpload()).toBe(false);
  });

  it("keeps one organization out of another's files", async () => {
    const mine = await putFile("orgA", upload("a.jpg", "image/jpeg", "A"));
    expect(mine.ok).toBe(true);
    if (!mine.ok) return;

    expect(mine.file.storagePath.startsWith("orgA/")).toBe(true);
    // The key carries the tenant, and /api/files/[id] only ever looks up rows
    // already scoped to the caller's organization — so a key alone is not a way
    // to reach another business's file.
    expect(isSafeKey(mine.file.storagePath)).toBe(true);
  });
});
