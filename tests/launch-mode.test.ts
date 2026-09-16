import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { launchMode, onlineAppUrl, ONLINE_APP_URL } = require(
  path.resolve(process.cwd(), "electron", "runtime.js"),
) as {
  launchMode: (input: {
    databaseExists: boolean;
    listAccounts?: () => unknown;
  }) => "local" | "online";
  onlineAppUrl: (env?: Record<string, string | undefined>) => string;
  ONLINE_APP_URL: string;
};

/**
 * Which way the desktop app starts.
 *
 * The expensive mistake is one direction only: an install holding a business
 * that opens onto the website, where that business does not exist, looks to
 * its owner like every record is gone. These pin that every doubt resolves
 * toward local, and that only a plainly empty install goes online.
 */

describe("launchMode", () => {
  it("goes online when there is no database, without trying to open one", () => {
    let listed = false;
    const mode = launchMode({
      databaseExists: false,
      listAccounts: () => {
        listed = true;
        return { ok: true, accounts: [] };
      },
    });

    expect(mode).toBe("online");
    // Opening a SQLite path that does not exist creates the file.
    expect(listed).toBe(false);
  });

  it("goes online when the database has nobody in it", () => {
    expect(
      launchMode({
        databaseExists: true,
        listAccounts: () => ({ ok: true, accounts: [] }),
      }),
    ).toBe("online");
  });

  it("stays local when the database holds an account", () => {
    expect(
      launchMode({
        databaseExists: true,
        listAccounts: () => ({ ok: true, accounts: [{ email: "owner@shop.test" }] }),
      }),
    ).toBe("local");
  });

  it("stays local when the accounts cannot be read", () => {
    const failures = [
      () => ({ ok: false, error: "database disk image is malformed" }),
      () => null,
      () => ({ ok: true }),
      () => {
        throw new Error("spawn failed");
      },
    ];

    for (const listAccounts of failures) {
      expect(launchMode({ databaseExists: true, listAccounts })).toBe("local");
    }
  });
});

/**
 * The same decision fed by the real recovery script, the way the launcher
 * calls it. launchMode reads that script's output, so a change to its shape
 * has to fail here rather than quietly send a full install online.
 */
describe("launchMode with the recovery tool's account list", () => {
  const SCRIPT = path.resolve(process.cwd(), "electron", "reset-password.js");
  let dir: string;
  let databaseFile: string;

  function listAccounts() {
    try {
      const stdout = execFileSync(process.execPath, [SCRIPT, databaseFile, "list"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return JSON.parse(stdout.trim().split("\n").pop() ?? "null");
    } catch (error) {
      const stdout = (error as { stdout?: string }).stdout ?? "";
      return JSON.parse(stdout.trim().split("\n").pop() || "null");
    }
  }

  function createDatabase(withAccount: boolean) {
    const Database = require("better-sqlite3");
    const db = new Database(databaseFile);
    // Only the columns the list query reads.
    db.exec(`
      CREATE TABLE "Organization" (id TEXT PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE "User" (
        id TEXT PRIMARY KEY, organizationId TEXT NOT NULL, email TEXT NOT NULL,
        name TEXT NOT NULL, role TEXT NOT NULL, isActive BOOLEAN NOT NULL
      );
    `);
    if (withAccount) {
      db.prepare(`INSERT INTO "Organization" VALUES ('org', 'Northside Services')`).run();
      db.prepare(
        `INSERT INTO "User" VALUES ('u', 'org', 'owner@northside.test', 'Alex', 'OWNER', 1)`,
      ).run();
    }
    db.close();
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "launch-mode-"));
    databaseFile = path.join(dir, "matlockone.db");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("sends an install with an empty database online", () => {
    createDatabase(false);
    expect(launchMode({ databaseExists: true, listAccounts })).toBe("online");
  });

  it("keeps an install with a business local", () => {
    createDatabase(true);
    expect(launchMode({ databaseExists: true, listAccounts })).toBe("local");
  });

  it("keeps an unreadable database local", () => {
    fs.writeFileSync(databaseFile, "this is not a database");
    expect(launchMode({ databaseExists: true, listAccounts })).toBe("local");
  });
});

describe("onlineAppUrl", () => {
  it("opens the live site by default", () => {
    expect(onlineAppUrl({})).toBe(ONLINE_APP_URL);
    expect(ONLINE_APP_URL).toBe("https://www.matlockone.com");
  });

  it("can be pointed elsewhere for development, without a trailing slash", () => {
    expect(onlineAppUrl({ MATLOCK_ONE_URL: " http://localhost:3100/ " })).toBe(
      "http://localhost:3100",
    );
    expect(onlineAppUrl({ MATLOCK_ONE_URL: "" })).toBe(ONLINE_APP_URL);
  });
});
