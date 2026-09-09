import path from "node:path";
import fs from "node:fs";
import { defineConfig, env } from "prisma/config";

// Prisma 7 no longer reads .env automatically. Next.js loads it for the app
// itself; this covers the CLI (generate / db push / seed / studio).
//
// An explicitly-set DATABASE_URL wins, so the test harness can point the CLI at
// a throwaway database without .env pulling it back to dev.db.
const envFile = path.join(process.cwd(), ".env");
if (!process.env.DATABASE_URL && fs.existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

/**
 * Which schema the CLI acts on, chosen by the database it has been pointed at.
 *
 * There are two: the authored Postgres schema and the SQLite projection of it
 * (scripts/sync-sqlite-schema.mjs). Picking here means `db push`, `db seed` and
 * `studio` follow DATABASE_URL automatically — the alternative is remembering a
 * `--schema` flag, and the failure when you forget is Prisma cheerfully pushing
 * Postgres DDL at a SQLite file.
 *
 * Duplicates the scheme test in src/lib/db-provider.ts rather than importing
 * it: this file is loaded by the Prisma CLI, which does not resolve the `@/`
 * path alias. Kept to a single line so the two cannot meaningfully drift.
 */
const isSqlite = (process.env.DATABASE_URL ?? "").trim().startsWith("file:");

export default defineConfig({
  schema: path.join("prisma", isSqlite ? "schema.sqlite.prisma" : "schema.prisma"),
  migrations: {
    path: path.join("prisma", "migrations"),
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    // DIRECT_DATABASE_URL when there is one. The CLI runs migrations, and a
    // migration cannot go through a transaction-mode connection pooler: it
    // needs a session it can hold, and pgBouncer will not give it one. The
    // application keeps using the pooled DATABASE_URL, which is the opposite
    // requirement and the reason these are two settings rather than one.
    url: process.env.DIRECT_DATABASE_URL?.trim()
      ? env("DIRECT_DATABASE_URL")
      : env("DATABASE_URL"),
  },
});
