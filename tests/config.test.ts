import { describe, expect, it } from "vitest";

import {
  configProblems,
  dataStaysOnThisMachine,
  resolveAppUrl,
  secureCookies,
  signupOpen,
  sweepsAutomatically,
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
  PAYPAL_CLIENT_ID: "client",
  PAYPAL_CLIENT_SECRET: "secret",
  PAYPAL_WEBHOOK_ID: "WH-1",
  PAYPAL_PLAN_STARTER_MONTHLY: "P-1",
  PAYPAL_PLAN_STARTER_ANNUAL: "P-2",
  PAYPAL_PLAN_BUSINESS_MONTHLY: "P-3",
  PAYPAL_PLAN_BUSINESS_ANNUAL: "P-4",
  PAYPAL_PLAN_PRO_MONTHLY: "P-5",
  PAYPAL_PLAN_PRO_ANNUAL: "P-6",
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

describe("secureCookies", () => {
  /**
   * A browser discards a Secure cookie that arrives over plain HTTP, so the flag
   * has to follow how the deployment is actually reached, not NODE_ENV, which is
   * "production" on the desktop build as well as the hosted one.
   */

  it("is secure on an HTTPS deployment", () => {
    expect(secureCookies({ APP_URL: "https://app.matlockone.com" })).toBe(true);
  });

  it("is secure on Vercel without an explicit APP_URL", () => {
    expect(
      secureCookies({ VERCEL_PROJECT_PRODUCTION_URL: "matlockone.vercel.app" }),
    ).toBe(true);
    expect(secureCookies({ VERCEL_URL: "matlockone-abc123.vercel.app" })).toBe(true);
  });

  it("is not secure where the crew reach the desktop build over the office network", () => {
    expect(
      secureCookies({ NODE_ENV: "production", APP_URL: "http://192.168.1.20:3000" }),
    ).toBe(false);
  });

  it("is not secure on plain HTTP localhost", () => {
    expect(
      secureCookies({ NODE_ENV: "production", APP_URL: "http://localhost:3000" }),
    ).toBe(false);
    expect(secureCookies({})).toBe(false);
  });
});

describe("signupOpen", () => {
  it("is open when nothing says otherwise, which a desktop install relies on", () => {
    expect(signupOpen({})).toBe(true);
    expect(signupOpen({ ALLOW_SIGNUP: "" })).toBe(true);
    expect(signupOpen({ ALLOW_SIGNUP: "true" })).toBe(true);
  });

  it("shuts on false however it was typed into the dashboard", () => {
    expect(signupOpen({ ALLOW_SIGNUP: "false" })).toBe(false);
    expect(signupOpen({ ALLOW_SIGNUP: "FALSE" })).toBe(false);
    expect(signupOpen({ ALLOW_SIGNUP: " false " })).toBe(false);
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

  it("warns when a hosted deployment cannot take a payment", () => {
    // No free tier: without PayPal a new business signs up and is stuck.
    expect(warningSettings({ PAYPAL_WEBHOOK_ID: undefined })).toContain("PAYPAL");
    expect(warningSettings({ PAYPAL_PLAN_PRO_ANNUAL: " " })).toContain("PAYPAL");
    expect(fatalSettings({ PAYPAL_CLIENT_ID: undefined })).not.toContain("PAYPAL");
    const message = problemsFor({ PAYPAL_CLIENT_SECRET: undefined }).find(
      (p) => p.setting === "PAYPAL",
    )?.message;
    expect(message).toContain("PAYPAL_CLIENT_SECRET");
    expect(message).not.toContain("PAYPAL_CLIENT_ID,");
  });

  it("does not ask a desktop install for PayPal", () => {
    // A desktop install pays by licence key and has none of these, rightly.
    const desktop = {
      NODE_ENV: "production",
      DATABASE_URL: "file:./matlock.db",
      SESSION_SECRET: "a".repeat(32),
      ENCRYPTION_KEY: "b".repeat(32),
      APP_URL: "http://127.0.0.1:3100",
      STORAGE_PROVIDER: "local",
    };
    expect(configProblems(desktop).map((p) => p.setting)).not.toContain("PAYPAL");
  });

  it("warns when client-facing links would point at localhost", () => {
    expect(warningSettings({ APP_URL: undefined })).toContain("APP_URL");
  });

  it("warns on Vercel when the morning automation run has no secret", () => {
    // The route turns Vercel's own call away without it, and nothing a person
    // looks at would otherwise say that the automations stopped running.
    expect(warningSettings({ VERCEL: "1", CRON_SECRET: undefined })).toContain("CRON_SECRET");
    expect(warningSettings({ VERCEL: "1", CRON_SECRET: "too-short" })).toContain("CRON_SECRET");
    expect(fatalSettings({ VERCEL: "1", CRON_SECRET: undefined })).not.toContain("CRON_SECRET");
  });

  it("says nothing about the morning run off Vercel, where there is none", () => {
    // A desktop install runs them from Check now. No secret is expected there.
    expect(warningSettings({ CRON_SECRET: undefined })).not.toContain("CRON_SECRET");
    expect(warningSettings({ VERCEL: "1", CRON_SECRET: "c".repeat(32) })).not.toContain(
      "CRON_SECRET",
    );
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

describe("sweepsAutomatically", () => {
  it("is true only on Vercel with a secret long enough to be one", () => {
    expect(sweepsAutomatically({ VERCEL: "1", CRON_SECRET: "c".repeat(32) })).toBe(true);
    expect(sweepsAutomatically({ VERCEL: "1", CRON_SECRET: "  short  " })).toBe(false);
    expect(sweepsAutomatically({ VERCEL: "1" })).toBe(false);
  });

  it("is false on a desktop install, secret or not", () => {
    // The settings screen tells a desktop user to press Check now. Saying the
    // check runs every morning there would leave overdue invoices unchased.
    expect(sweepsAutomatically({ CRON_SECRET: "c".repeat(32) })).toBe(false);
  });
});
