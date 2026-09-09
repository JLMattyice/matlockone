import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * The SQLite schema is projected from the Postgres one rather than maintained
 * beside it, because two hand-written copies of 950 lines drift — and the drift
 * shows up months later as a column that exists in the cloud and not on a
 * customer's desktop. These cover the two guards that make the projection safe
 * to rely on.
 */

const SCRIPT = path.resolve("scripts/sync-sqlite-schema.mjs");
const temporary: string[] = [];

function sandbox(schema: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "schema-sync-"));
  temporary.push(dir);
  fs.mkdirSync(path.join(dir, "prisma"));
  fs.writeFileSync(path.join(dir, "prisma", "schema.prisma"), schema);
  return dir;
}

function run(cwd: string, args: string[] = []) {
  return execFileSync(process.execPath, [SCRIPT, ...args], {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
  });
}

const VALID = `generator client {
  provider = "prisma-client"
  output   = "../src/generated/prisma"
}

datasource db {
  provider = "postgresql"
}

model Client {
  id       String    @id @default(cuid())
  name     String
  jobs     Job[]
}

model Job {
  id       String  @id @default(cuid())
  clientId String
  client   Client  @relation(fields: [clientId], references: [id])
}
`;

afterEach(() => {
  for (const dir of temporary.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("sync-sqlite-schema", () => {
  it("changes the provider and the output path, and nothing else", () => {
    const dir = sandbox(VALID);
    run(dir);

    const projected = fs.readFileSync(
      path.join(dir, "prisma", "schema.sqlite.prisma"),
      "utf8",
    );

    expect(projected).toContain('provider = "sqlite"');
    expect(projected).toContain('output   = "../src/generated/sqlite"');
    expect(projected).not.toContain("postgresql");
    // The models must survive the projection untouched — that is the point.
    expect(projected).toContain("model Client {");
    expect(projected).toContain("jobs     Job[]");
  });

  it("does not mistake a relation list for a scalar list", () => {
    // `Job[]` is a relation and is fine on SQLite; `String[]` is not. An
    // over-eager check here would block a perfectly portable schema.
    expect(() => run(sandbox(VALID))).not.toThrow();
  });

  it("refuses a scalar list, which SQLite cannot represent", () => {
    const dir = sandbox(VALID.replace("  name     String", "  tags     String[]"));
    expect(() => run(dir)).toThrow(/scalar list/);
  });

  it("refuses an enum", () => {
    const dir = sandbox(`${VALID}\nenum Status {\n  ACTIVE\n}\n`);
    expect(() => run(dir)).toThrow(/enum/);
  });

  it("refuses a Postgres-only native type attribute", () => {
    const dir = sandbox(VALID.replace("  name     String", "  name     String @db.VarChar(200)"));
    expect(() => run(dir)).toThrow(/native type/);
  });

  it("--check fails when the projection is stale", () => {
    const dir = sandbox(VALID);
    run(dir);

    // Simulate someone editing the generated file, or the source moving on
    // without a re-sync.
    fs.appendFileSync(
      path.join(dir, "prisma", "schema.sqlite.prisma"),
      "\nmodel Stale {\n  id String @id\n}\n",
    );

    expect(() => run(dir, ["--check"])).toThrow(/out of date/);
  });

  it("--check passes for the schema actually in the repository", () => {
    // Guards the real files, so a schema change committed without a re-sync
    // fails here rather than in a desktop build.
    expect(() => run(process.cwd(), ["--check"])).not.toThrow();
  });
});
