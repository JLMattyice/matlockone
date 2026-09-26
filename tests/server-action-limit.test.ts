import { describe, expect, it } from "vitest";

import nextConfig from "../next.config";
import { MAX_PHOTOS_PER_MESSAGE } from "@/lib/chat";
import { MAX_UPLOAD_BYTES } from "@/lib/storage-limits";

/**
 * Where files are stored on the server's own disk — every desktop install —
 * uploads travel inside a server action, and Next refuses a server action's
 * request past a size limit whose default is 1MB. With the default, a photo
 * off a phone could not be uploaded or sent in a job thread at all.
 */

const UPLOAD_FORM_MAX_FILES = 10;

describe("the server action body limit", () => {
  const limit = nextConfig.experimental?.serverActions?.bodySizeLimit;

  it("is a number of bytes, so the comparison below means something", () => {
    expect(typeof limit).toBe("number");
  });

  it("takes a full upload form of the largest files the app accepts", () => {
    expect(limit as number).toBeGreaterThan(UPLOAD_FORM_MAX_FILES * MAX_UPLOAD_BYTES);
  });

  it("takes a job-thread message with every photo it may carry", () => {
    expect(limit as number).toBeGreaterThan(MAX_PHOTOS_PER_MESSAGE * MAX_UPLOAD_BYTES);
  });
});
