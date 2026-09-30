import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  launchMode,
  shouldExplainOnline,
  onlineAppUrl,
  ONLINE_APP_URL,
  choseOnline,
  writeOnlineChoice,
  choseLocal,
  writeLocalChoice,
  clearLocalChoice,
} = require(path.resolve(process.cwd(), "electron", "runtime.js")) as {
  launchMode: (input?: { choseLocal?: boolean }) => "local" | "online";
  shouldExplainOnline: (input: {
    databaseExists: boolean;
    alreadyKnows: boolean;
    listAccounts: () => unknown;
  }) => boolean;
  choseOnline: (file: string) => boolean;
  writeOnlineChoice: (file: string, at?: Date) => void;
  choseLocal: (file: string) => boolean;
  writeLocalChoice: (file: string, at?: Date) => void;
  clearLocalChoice: (file: string) => void;
  onlineAppUrl: (env?: Record<string, string | undefined>) => string;
  ONLINE_APP_URL: string;
};

/**
 * Which way the desktop app starts: the online account, on every computer,
 * unless the owner chose the business stored on this one from the File menu.
 */
describe("launchMode", () => {
  it("opens the online account by default", () => {
    expect(launchMode()).toBe("online");
    expect(launchMode({})).toBe("online");
    expect(launchMode({ choseLocal: false })).toBe("online");
  });

  it("opens the business on this computer only when the owner chose it", () => {
    expect(launchMode({ choseLocal: true })).toBe("local");
  });
});

/**
 * The one-time notice for an install that held a business of its own before
 * it started opening online. The expensive mistake is one direction only: an
 * owner who opens the app to a sign-in page, with no word about where their
 * business went, believes every record is gone. So every doubt resolves
 * toward telling them.
 */
describe("shouldExplainOnline", () => {
  const withBusiness = () => ({ ok: true, accounts: [{ email: "owner@shop.test" }] });

  it("says nothing on a new install, without trying to open a database", () => {
    let listed = false;
    const explain = shouldExplainOnline({
      databaseExists: false,
      alreadyKnows: false,
      listAccounts: () => {
        listed = true;
        return withBusiness();
      },
    });

    expect(explain).toBe(false);
    // Opening a SQLite path that does not exist creates the file.
    expect(listed).toBe(false);
  });

  it("says nothing to an owner who already knows, without opening the database", () => {
    let listed = false;
    const explain = shouldExplainOnline({
      databaseExists: true,
      alreadyKnows: true,
      listAccounts: () => {
        listed = true;
        return withBusiness();
      },
    });

    expect(explain).toBe(false);
    expect(listed).toBe(false);
  });

  it("says nothing when the database has nobody in it", () => {
    expect(
      shouldExplainOnline({
        databaseExists: true,
        alreadyKnows: false,
        listAccounts: () => ({ ok: true, accounts: [] }),
      }),
    ).toBe(false);
  });

  it("tells an install that holds a business", () => {
    expect(
      shouldExplainOnline({ databaseExists: true, alreadyKnows: false, listAccounts: withBusiness }),
    ).toBe(true);
  });

  it("tells an install whose accounts cannot be read", () => {
    const failures = [
      () => ({ ok: false, error: "database disk image is malformed" }),
      () => null,
      () => ({ ok: true }),
      () => {
        throw new Error("spawn failed");
      },
    ];

    for (const listAccounts of failures) {
      expect(shouldExplainOnline({ databaseExists: true, alreadyKnows: false, listAccounts })).toBe(
        true,
      );
    }
  });
});

/**
 * The same decision fed by the real recovery script, the way the launcher
 * calls it. shouldExplainOnline reads that script's output, so a change to its
 * shape has to fail here rather than quietly skip the notice on a full install.
 */
describe("shouldExplainOnline with the recovery tool's account list", () => {
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

  const explain = () =>
    shouldExplainOnline({ databaseExists: true, alreadyKnows: false, listAccounts });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "launch-mode-"));
    databaseFile = path.join(dir, "matlockone.db");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("says nothing about an empty database", () => {
    createDatabase(false);
    expect(explain()).toBe(false);
  });

  it("tells an install with a business", () => {
    createDatabase(true);
    expect(explain()).toBe(true);
  });

  it("tells an install whose database cannot be read", () => {
    fs.writeFileSync(databaseFile, "this is not a database");
    expect(explain()).toBe(true);
  });
});

/**
 * The two files beside the database: "use-this-computer" is the owner's choice
 * of the business stored here, and "use-online-account" records that they know
 * this computer opens the online account (0.6.1 wrote it for its File-menu
 * switch, so those owners are not told again).
 */
describe("the launch choices", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "launch-choice-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("remembers choosing this computer's business, and forgets it when removed", () => {
    const file = path.join(dir, "use-this-computer");
    expect(choseLocal(file)).toBe(false);

    writeLocalChoice(file, new Date("2026-09-29T12:00:00Z"));
    expect(choseLocal(file)).toBe(true);
    // Someone who finds it while troubleshooting should know what it does.
    expect(fs.readFileSync(file, "utf8")).toContain("Delete this file");

    clearLocalChoice(file);
    expect(choseLocal(file)).toBe(false);
    // Switching back twice is harmless.
    expect(() => clearLocalChoice(file)).not.toThrow();
  });

  it("remembers that the owner knows this computer opens the online account", () => {
    const file = path.join(dir, "use-online-account");
    expect(choseOnline(file)).toBe(false);

    writeOnlineChoice(file, new Date("2026-09-29T12:00:00Z"));
    expect(choseOnline(file)).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toContain("Use the business on this computer");
  });

  it("still honours the file 0.6.1 wrote for its switch", () => {
    const file = path.join(dir, "use-online-account");
    fs.writeFileSync(
      file,
      "Chose the online account on 2026-09-29T12:00:00.000Z.\n" +
        "Delete this file to open the business stored on this computer again.\n",
    );
    expect(choseOnline(file)).toBe(true);
  });

  it("creates the data folder if it is missing", () => {
    const local = path.join(dir, "not-yet", "use-this-computer");
    writeLocalChoice(local);
    expect(choseLocal(local)).toBe(true);

    const online = path.join(dir, "not-yet-either", "use-online-account");
    writeOnlineChoice(online);
    expect(choseOnline(online)).toBe(true);
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
