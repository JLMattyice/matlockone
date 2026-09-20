import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * `db:deploy` reaching dev.db is not a harmless mistake with a clear error: it
 * fails with P3005 and a link about baselining a production database, which
 * describes neither the database it touched nor the credentials it lacked.
 * These pin the cases the guard has to catch.
 */

const SCRIPT = path.resolve("scripts/require-hosted-database.mjs");
const HOSTED = "postgresql://postgres.ref:pw@aws-0-us-west-2.pooler.supabase.com:5432/postgres";
const temporary: string[] = [];

/**
 * A directory with no `.env`, so the script sees only what each case passes.
 * Run in the real project directory it would read the developer's own file.
 */
function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "migrate-guard-"));
  temporary.push(dir);
  return dir;
}

function run(env: Record<string, string>, cwd = sandbox()) {
  const result = spawnSync(process.execPath, [SCRIPT], {
    cwd,
    encoding: "utf8",
    // An inherited DATABASE_URL would decide the outcome instead of the case,
    // so the child gets only PATH, NODE_ENV (which the typed env requires) and
    // whatever this case sets.
    env: { PATH: process.env.PATH ?? "", NODE_ENV: "test", ...env },
  });

  return { code: result.status, stderr: result.stderr };
}

afterEach(() => {
  for (const dir of temporary.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("the db:deploy guard", () => {
  it("lets a hosted connection string through", () => {
    expect(run({ DATABASE_URL: HOSTED }).code).toBe(0);
  });

  it("refuses a local SQLite file, naming what to set", () => {
    const { code, stderr } = run({ DATABASE_URL: "file:./dev.db" });

    expect(code).toBe(1);
    expect(stderr).toContain("local SQLite file");
    // The point of the guard is the instruction, not the refusal.
    expect(stderr).toContain("db:push");
  });

  it("refuses the half-set case, which would carry the wrong schema to Postgres", () => {
    // prisma.config.ts picks the schema from DATABASE_URL and connects with
    // DIRECT_DATABASE_URL, so this pair loads SQLite's schema and points it at
    // a real hosted database.
    const { code, stderr } = run({
      DATABASE_URL: "file:./dev.db",
      DIRECT_DATABASE_URL: HOSTED,
    });

    expect(code).toBe(1);
    expect(stderr).toContain("DATABASE_URL is still a local file");
  });

  it("catches the placeholder from the documentation, brackets and all", () => {
    // Prisma's own complaint is "the scheme is not recognized in database
    // URL", which names the symptom rather than the mistake.
    const { code, stderr } = run({ DATABASE_URL: "<direct connection string>" });

    expect(code).toBe(1);
    expect(stderr).toContain("still the placeholder");
  });

  it("refuses anything that is not a Postgres URL", () => {
    const { code, stderr } = run({ DATABASE_URL: "mysql://root@localhost/app" });

    expect(code).toBe(1);
    expect(stderr).toContain("not a Postgres connection string");
  });

  it("refuses when nothing is set at all", () => {
    const { code, stderr } = run({});

    expect(code).toBe(1);
    expect(stderr).toContain("neither DATABASE_URL nor DIRECT_DATABASE_URL");
  });

  it("reads .env the way prisma.config.ts does when nothing is in the environment", () => {
    const dir = sandbox();
    fs.writeFileSync(path.join(dir, ".env"), 'DATABASE_URL="file:./dev.db"\n');

    // The failing case from real use: the developer sets nothing, and .env
    // quietly supplies the local file.
    expect(run({}, dir).code).toBe(1);
  });

  it("lets an explicit hosted URL win over a .env holding dev.db", () => {
    const dir = sandbox();
    fs.writeFileSync(path.join(dir, ".env"), 'DATABASE_URL="file:./dev.db"\n');

    expect(run({ DATABASE_URL: HOSTED }, dir).code).toBe(0);
  });
});
