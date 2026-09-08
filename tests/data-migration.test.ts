import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { legacyDataDirs, migrateLegacyData } = require(
  path.resolve(process.cwd(), "electron", "runtime.js"),
) as {
  legacyDataDirs: (app: { getPath: (n: string) => string; getName: () => string }) => string[];
  migrateLegacyData: (
    root: string,
    legacyNames: string | string[],
    databaseFile: string,
  ) => { from: string; copied: string[] } | null;
};

/**
 * Carrying a customer's data across a rename.
 *
 * This exists because it already went wrong once: a find-and-replace over the
 * old product name rewrote the *legacy folder* argument to the new name, so the
 * app looked for the folder it was already using, found nothing, and opened
 * with an empty database. Nothing was lost only because the migration copies
 * rather than moves.
 */

const DB_NAME = "matlockone.db";
const LEGACY_DB_NAME = "fieldbase.db";

let base: string;
const root = () => path.join(base, "Matlock One");
const databaseFile = () => path.join(root(), DB_NAME);
const legacyDir = (name: string) => path.join(base, name);

function seedLegacy(name: string, contents: string) {
  const dir = path.join(base, name);
  fs.mkdirSync(path.join(dir, "storage"), { recursive: true });
  fs.writeFileSync(path.join(dir, LEGACY_DB_NAME), contents);
  fs.writeFileSync(path.join(dir, "session.key"), "session-secret");
  fs.writeFileSync(path.join(dir, "encryption.key"), "encryption-secret");
  fs.writeFileSync(path.join(dir, "storage", "photo.jpg"), "an uploaded file");
  fs.writeFileSync(path.join(dir, `${name}-backup-2026-01-01.db`), "a backup");
  return dir;
}

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "m1-migrate-"));
  fs.mkdirSync(root(), { recursive: true });
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe("migrateLegacyData", () => {
  it("renames the database from the name it shipped under", () => {
    seedLegacy("Fieldbase", "REAL BUSINESS DATA");

    const result = migrateLegacyData(root(), [legacyDir("Fieldbase")], databaseFile());

    // The old installation called it fieldbase.db; this one calls it
    // matlockone.db, and the rows have to survive the rename.
    expect(fs.existsSync(databaseFile())).toBe(true);
    expect(fs.readFileSync(databaseFile(), "utf8")).toBe("REAL BUSINESS DATA");
    expect(result?.copied.join(" ")).toContain("fieldbase.db -> matlockone.db");
  });

  it("carries the database, keys and uploads across", () => {
    seedLegacy("Fieldbase", "REAL BUSINESS DATA");

    const result = migrateLegacyData(root(), [legacyDir("Work Suite"), legacyDir("Fieldbase")], databaseFile());

    expect(result).not.toBeNull();
    expect(fs.readFileSync(databaseFile(), "utf8")).toBe("REAL BUSINESS DATA");
    expect(fs.existsSync(path.join(root(), "session.key"))).toBe(true);
    expect(fs.existsSync(path.join(root(), "encryption.key"))).toBe(true);
    // Without the storage folder every photo and document on every job is gone.
    expect(fs.readFileSync(path.join(root(), "storage", "photo.jpg"), "utf8")).toBe(
      "an uploaded file",
    );
  });

  it("brings the write-ahead log but never the -shm", () => {
    const legacy = seedLegacy("Fieldbase", "data");
    fs.writeFileSync(path.join(legacy, `${LEGACY_DB_NAME}-wal`), "wal");
    fs.writeFileSync(path.join(legacy, `${LEGACY_DB_NAME}-shm`), "shm");

    migrateLegacyData(root(), [legacyDir("Fieldbase")], databaseFile());

    // Without the -wal, transactions committed but not yet checkpointed are
    // silently dropped — the customer opens an emptier business.
    expect(fs.existsSync(path.join(root(), `${DB_NAME}-wal`))).toBe(true);
    // With the -shm, SQLite reads a stale image: every row is in the file, but
    // the application sees an older version of it.
    expect(fs.existsSync(path.join(root(), `${DB_NAME}-shm`))).toBe(false);
  });

  it("brings backups along too", () => {
    seedLegacy("Fieldbase", "data");

    migrateLegacyData(root(), [legacyDir("Fieldbase")], databaseFile());

    expect(fs.existsSync(path.join(root(), "Fieldbase-backup-2026-01-01.db"))).toBe(
      true,
    );
  });

  it("leaves the original in place", () => {
    const legacy = seedLegacy("Fieldbase", "data");

    migrateLegacyData(root(), [legacyDir("Fieldbase")], databaseFile());

    // A copy, not a move: if this goes wrong the customer still has everything.
    expect(fs.existsSync(path.join(legacy, LEGACY_DB_NAME))).toBe(true);
  });

  it("never overwrites data the new folder already has", () => {
    seedLegacy("Fieldbase", "OLD");
    fs.writeFileSync(databaseFile(), "CURRENT");

    const result = migrateLegacyData(root(), [legacyDir("Fieldbase")], databaseFile());

    expect(result).toBeNull();
    expect(fs.readFileSync(databaseFile(), "utf8")).toBe("CURRENT");
  });

  it("prefers the most recent previous name", () => {
    seedLegacy("Fieldbase", "OLDEST");
    seedLegacy("Work Suite", "MORE RECENT");

    migrateLegacyData(root(), [legacyDir("Work Suite"), legacyDir("Fieldbase")], databaseFile());

    expect(fs.readFileSync(databaseFile(), "utf8")).toBe("MORE RECENT");
  });

  it("falls through to an older name when the newer one has no data", () => {
    seedLegacy("Fieldbase", "REAL DATA");
    fs.mkdirSync(path.join(base, "Work Suite"), { recursive: true });

    migrateLegacyData(root(), [legacyDir("Work Suite"), legacyDir("Fieldbase")], databaseFile());

    expect(fs.readFileSync(databaseFile(), "utf8")).toBe("REAL DATA");
  });

  it("does nothing when there is no previous installation", () => {
    expect(migrateLegacyData(root(), [legacyDir("Fieldbase")], databaseFile())).toBeNull();
  });

  it("refuses to treat its own folder as the source", () => {
    // The bug this file exists for: passing the *current* name as the legacy
    // one. It must be a no-op, not a self-copy or a crash.
    seedLegacy("Matlock One", "data");
    fs.rmSync(databaseFile(), { force: true });

    expect(migrateLegacyData(root(), [legacyDir("Matlock One")], databaseFile())).toBeNull();
  });

  it("accepts a single name as well as a list", () => {
    seedLegacy("Fieldbase", "data");

    const result = migrateLegacyData(root(), legacyDir("Fieldbase"), databaseFile());

    expect(result?.copied.join(" ")).toContain(LEGACY_DB_NAME);
  });

  it("reports what it moved and where from", () => {
    seedLegacy("Fieldbase", "data");

    const result = migrateLegacyData(root(), [legacyDir("Fieldbase")], databaseFile());

    expect(result?.from).toBe(path.join(base, "Fieldbase"));
    expect(result?.copied).toEqual(
      expect.arrayContaining(["session.key", "encryption.key", "storage"]),
    );
  });
});

describe("the launcher's list of previous locations", () => {
  /**
   * The list itself, rather than the function that consumes it. A rename once
   * swept through this argument and pointed the app at the folder it was
   * already using, which made the migration a silent no-op and started the
   * customer with an empty database.
   */
  const ROAMING = path.join("C:", "Users", "test", "AppData", "Roaming");
  const LOCAL = path.join("C:", "Users", "test", "AppData", "Local");

  let dirs: string[] = [];
  let realLocalAppData: string | undefined;

  beforeEach(() => {
    realLocalAppData = process.env.LOCALAPPDATA;
    process.env.LOCALAPPDATA = LOCAL;
    dirs = legacyDataDirs({
      getPath: (name: string) => (name === "appData" ? ROAMING : "unused"),
      getName: () => "Matlock One",
    });
  });

  afterEach(() => {
    if (realLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = realLocalAppData;
  });

  it("still knows the name the app first shipped under", () => {
    expect(dirs.some((d) => d.endsWith("Fieldbase"))).toBe(true);
  });

  it("knows the Roaming folders the early builds kept data in", () => {
    expect(dirs).toEqual(
      expect.arrayContaining([
        path.join(ROAMING, "Work Suite"),
        path.join(ROAMING, "work-suite"),
        path.join(ROAMING, "Fieldbase"),
      ]),
    );
  });

  it("looks in Local for the folder holding today's live data", () => {
    // The Work Suite build moved data off Roaming, so its Local folder is
    // where every machine upgrading into this release keeps its business.
    // Miss this one and the whole rename opens to an empty database.
    expect(dirs).toContain(path.join(LOCAL, "Work Suite"));
  });

  it("tries the newest previous name first", () => {
    // migrateLegacyData takes the first entry that has a database, so a
    // machine that has been through both renames must not land on Fieldbase.
    expect(dirs[0]).toBe(path.join(LOCAL, "Work Suite"));
    expect(dirs.indexOf(path.join(ROAMING, "Work Suite"))).toBeLessThan(
      dirs.indexOf(path.join(ROAMING, "Fieldbase")),
    );
  });

  it("never lists the folder the app is currently using", () => {
    // The bug this file exists for, at the source: a rename sweeping through
    // this list points the app at itself and the migration silently no-ops.
    expect(dirs.some((d) => d.endsWith("Matlock One"))).toBe(false);
  });
});
