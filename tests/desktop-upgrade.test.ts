import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

// The same driver the desktop install uses, typed here as far as this file
// reaches into it: the package ships no types, and one test is no reason to
// add a dependency for them.
type Connection = {
  prepare(sql: string): { all(): unknown[]; run(...values: unknown[]): unknown };
  close(): void;
};
const Database = createRequire(import.meta.url)("better-sqlite3") as new (file: string) => Connection;

/**
 * Bringing a desktop install's database forward, run the way the launcher
 * runs it: electron/init-db.js under Node, a database file and the DDL the
 * new build ships.
 *
 * The case worth pinning is the paywall's arrival. A business already on a
 * desktop install was working the day before 0.5.0, and stays open after it:
 * the upgrade that adds billingExempt marks it exempt. Nothing else is ever
 * marked — not a business on a fresh install, and not one set back to billed
 * after the column already exists.
 */

const BEFORE = `
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isDemo" BOOLEAN NOT NULL DEFAULT false
);
`;

const AFTER = `
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "billingExempt" BOOLEAN NOT NULL DEFAULT false,
    "subscriptionId" TEXT,
    "paidThrough" DATETIME
);

-- CreateIndex
CREATE UNIQUE INDEX "Organization_subscriptionId_key" ON "Organization"("subscriptionId");
`;

const dirs: string[] = [];

function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mo-upgrade-"));
  dirs.push(dir);
  const write = (name: string, sql: string) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, sql);
    return file;
  };
  return { db: path.join(dir, "matlock.db"), before: write("before.sql", BEFORE), after: write("after.sql", AFTER) };
}

function initDb(db: string, sql: string) {
  const out = execFileSync(process.execPath, [path.join("electron", "init-db.js"), db, sql], {
    encoding: "utf8",
  });
  return JSON.parse(out.trim().split("\n").pop()!);
}

function rows(db: string) {
  const conn = new Database(db);
  try {
    return conn.prepare('SELECT "slug", "billingExempt" FROM "Organization" ORDER BY "slug"').all();
  } finally {
    conn.close();
  }
}

function addBusiness(db: string, slug: string, fields: Record<string, number> = {}) {
  const conn = new Database(db);
  try {
    const columns = ["id", "slug", "name", ...Object.keys(fields)];
    const values = [`org_${slug}`, slug, slug, ...Object.values(fields)];
    conn
      .prepare(`INSERT INTO "Organization" (${columns.map((c) => `"${c}"`).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
      .run(...values);
  } finally {
    conn.close();
  }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("upgrading a desktop install to the paywall", () => {
  it("keeps every business already on it open", async () => {
    const w = workspace();
    initDb(w.db, w.before);
    addBusiness(w.db, "harbor-glass");
    addBusiness(w.db, "cedar-row");

    const result = initDb(w.db, w.after);

    expect(result).toMatchObject({ ok: true, created: false, needsMigration: [] });
    expect(result.addedColumns).toContain("Organization.billingExempt");
    expect(result.backfilled).toEqual([{ column: "Organization.billingExempt", rows: 2 }]);
    expect(rows(w.db)).toEqual([
      { slug: "cedar-row", billingExempt: 1 },
      { slug: "harbor-glass", billingExempt: 1 },
    ]);
  });

  it("marks nothing on a fresh install", async () => {
    const w = workspace();

    const result = initDb(w.db, w.after);
    addBusiness(w.db, "brand-new");

    expect(result).toMatchObject({ ok: true, created: true, backfilled: [] });
    expect(rows(w.db)).toEqual([{ slug: "brand-new", billingExempt: 0 }]);
  });

  it("marks nothing on a later upgrade, once the column is there", async () => {
    // A business set back to billed by hand must stay billed through 0.5.1.
    const w = workspace();
    initDb(w.db, w.before);
    addBusiness(w.db, "harbor-glass");
    initDb(w.db, w.after);
    const conn = new Database(w.db);
    conn.prepare(`UPDATE "Organization" SET "billingExempt" = 0`).run();
    conn.close();
    addBusiness(w.db, "joined-later", { billingExempt: 0 });

    const again = initDb(w.db, w.after);

    expect(again.backfilled).toEqual([]);
    expect(rows(w.db)).toEqual([
      { slug: "harbor-glass", billingExempt: 0 },
      { slug: "joined-later", billingExempt: 0 },
    ]);
  });
});
