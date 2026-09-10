import { describe, expect, it } from "vitest";

import {
  configProblems,
  dataStaysOnThisMachine,
  resolveAppUrl,
} from "@/lib/config";

/**
 * A hosted deployment is configured by hand in a dashboard, and its
 * misconfigurations are quiet: the server starts, pages render, and the damage
 * appears later in a customer's inbox. These pin the checks that turn those into
 * a deployment that plainly refused to start.
 */

const GOOD = {
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://u:p@host:5432/matlockone",
  SESSION_SECRET: "a".repeat(32),
  ENCRYPTION_KEY: "b".repeat(32),
  APP_URL: "https://app.matlockone.com",
  STORAGE_PROVIDER: "s3",
  S3_BUCKET: "files",
  S3_ACCESS_KEY_ID: "key",
  S3_SECRET_ACCESS_KEY: "secret",
};

const problemsFor = (env: Record<string, string | undefined>) =>
  configProblems({ ...GOOD, ...env });

const fatalSettings = (env: Record<string, string | undefined>) =>
  problemsFor(env).filter((p) => p.level === "fatal").map((p) => p.setting);

const warningSettings = (env: Record<string, string | undefined>) =>
  problemsFor(env).filter((p) => p.level === "warning").map((p) => p.setting);

describe("resolveAppUrl", () => {
  it("prefers an explicit APP_URL", () => {
    expect(
      resolveAppUrl({
        APP_URL: "https://app.matlockone.com",
        VERCEL_PROJECT_PRODUCTION_URL: "other.vercel.app",
      }),
    ).toBe("https://app.matlockone.com");
  });

  it("strips a trailing slash, so links do not double up", () => {
    expect(resolveAppUrl({ APP_URL: "https://app.matlockone.com/" })).toBe(
      "https://app.matlockone.com",
    );
  });

  it("uses the production domain over the per-deployment one", () => {
    // A deployment URL works today and 404s the moment the next deploy replaces
    // it — the wrong property for a link sitting in a customer's inbox.
    expect(
      resolveAppUrl({
        VERCEL_PROJECT_PRODUCTION_URL: "matlockone.vercel.app",
        VERCEL_URL: "matlockone-abc123.vercel.app",
      }),
    ).toBe("https://matlockone.vercel.app");
  });

  it("falls back to the deployment URL on a preview build", () => {
    expect(resolveAppUrl({ VERCEL_URL: "matlockone-abc123.vercel.app" })).toBe(
      "https://matlockone-abc123.vercel.app",
    );
  });

  it("falls back to localhost with nothing set", () => {
    expect(resolveAppUrl({})).toBe("http://localhost:3000");
  });
});

describe("dataStaysOnThisMachine", () => {
  /**
   * This one guards a sentence shown to a customer on the screen that asks for
   * their business — "everything stays on this computer". It is only allowed to
   * be true when both halves of their data really are on the machine serving
   * the page.
   */

  it("is true for a desktop install: SQLite beside the app, files on the disk", () => {
    expect(
      dataStaysOnThisMachine({
        DATABASE_URL: "file:./dev.db",
        STORAGE_DIR: "./storage",
      }),
    ).toBe(true);
  });

  it("is false for the hosted deployment", () => {
    expect(dataStaysOnThisMachine(GOOD)).toBe(false);
  });

  it("is false when the database is local but the files are not", () => {
    // Records on the machine, photos in a bucket. The promise does not hold.
    expect(
      dataStaysOnThisMachine({
        DATABASE_URL: "file:./dev.db",
        STORAGE_PROVIDER: "s3",
        S3_BUCKET: "files",
        S3_ACCESS_KEY_ID: "key",
      }),
    ).toBe(false);
  });

  it("is false when the database is Postgres even with local file storage", () => {
    expect(
      dataStaysOnThisMachine({
        DATABASE_URL: "postgresql://u:p@host:5432/matlockone",
        STORAGE_DIR: "./storage",
      }),
    ).toBe(false);
  });

  it("does not throw, and does not promise, on an unreadable configuration", () => {
    // providerFor() throws on both of these. Failing towards "hosted" means a
    // broken deployment stays quiet rather than making a promise about a
    // customer's data that nothing has checked.
    expect(dataStaysOnThisMachine({})).toBe(false);
    expect(dataStaysOnThisMachine({ DATABASE_URL: "mysql://u:p@host/db" })).toBe(
      false,
    );
  });
});

describe("configProblems", () => {
  it("passes a properly configured hosted deployment", () => {
    expect(configProblems(GOOD)).toEqual([]);
  });

  it("refuses to start without a database", () => {
    expect(fatalSettings({ DATABASE_URL: undefined })).toContain("DATABASE_URL");
  });

  it("refuses a database URL it cannot place", () => {
    expect(fatalSettings({ DATABASE_URL: "mysql://u:p@host/db" })).toContain(
      "DATABASE_URL",
    );
  });

  it("refuses to start without a session secret", () => {
    expect(fatalSettings({ SESSION_SECRET: undefined })).toContain("SESSION_SECRET");
  });

  it("refuses a short session secret in production", () => {
    expect(fatalSettings({ SESSION_SECRET: "short" })).toContain("SESSION_SECRET");
  });

  it("only warns about a short session secret in development", () => {
    const env = { ...GOOD, NODE_ENV: "development", SESSION_SECRET: "short" };
    expect(configProblems(env).filter((p) => p.level === "fatal")).toEqual([]);
    expect(configProblems(env).map((p) => p.setting)).toContain("SESSION_SECRET");
  });

  it("warns, but does not refuse, without an encryption key", () => {
    // The app runs without it and the screens that need it say so. The business
    // finds out the day they try to send an invoice, which is why it is loud.
    expect(warningSettings({ ENCRYPTION_KEY: undefined })).toContain("ENCRYPTION_KEY");
    expect(fatalSettings({ ENCRYPTION_KEY: undefined })).not.toContain("ENCRYPTION_KEY");
  });

  it("warns when client-facing links would point at localhost", () => {
    expect(warningSettings({ APP_URL: undefined })).toContain("APP_URL");
  });

  it("says nothing about APP_URL when Vercel supplies the domain", () => {
    expect(
      warningSettings({
        APP_URL: undefined,
        VERCEL_PROJECT_PRODUCTION_URL: "matlockone.vercel.app",
      }),
    ).not.toContain("APP_URL");
  });

  it("refuses local disk storage on Vercel", () => {
    // Uploads would appear to succeed and be gone by the next request.
    expect(
      fatalSettings({
        VERCEL: "1",
        STORAGE_PROVIDER: undefined,
        S3_BUCKET: undefined,
        S3_ACCESS_KEY_ID: undefined,
      }),
    ).toContain("STORAGE_PROVIDER");
  });

  it("accepts cloud storage on Vercel", () => {
    expect(fatalSettings({ VERCEL: "1" })).toEqual([]);
  });
});
