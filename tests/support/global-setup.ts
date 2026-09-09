import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

/**
 * Builds a throwaway SQLite database for the integration tests.
 *
 * A separate file from dev.db, recreated from the schema on every run, so the
 * tests never read or write the data you are demoing — and a failing test can
 * never leave the demo in a strange state.
 */

const DATABASE_URL = "file:./test.db";

/**
 * Where `file:./test.db` actually lands.
 *
 * Prisma resolves a relative SQLite path against the working directory, not
 * against prisma/. Deleting the wrong path leaves a database that accumulates
 * across runs: tests then pass or fail depending on what a previous run left
 * behind, and a schema change fails to apply because the old shape is still
 * there. Derived from the URL rather than hardcoded so the two cannot drift.
 */
function databaseFile(url: string) {
  return path.resolve(process.cwd(), url.replace(/^file:/, ""));
}

function remove(file: string) {
  // SQLite spreads itself over sidecar files in WAL mode; leaving one behind
  // resurrects the data the main file was deleted to get rid of.
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    try {
      fs.rmSync(`${file}${suffix}`, { force: true });
    } catch {
      // On Windows a connection that has not finished closing still holds the
      // file, and rm fails with EPERM. The next run deletes it before pushing
      // the schema, so failing the whole suite over cleanup would report a
      // problem that does not exist.
    }
  }
}

/**
 * Generates a Prisma client if it is not already on disk.
 *
 * The tests run on SQLite, but src/lib/db.ts imports the Postgres client too —
 * it is where the types the application is written against come from — so a
 * fresh clone cannot import the module until both exist. Skipped when they are
 * already there, because regenerating both on every run costs more than the
 * whole suite.
 */
function ensureClient(root: string, generated: string, schema: string, prismaCli: string) {
  if (fs.existsSync(path.join(root, generated, "client.ts"))) return;

  execFileSync(process.execPath, [prismaCli, "generate", "--schema", schema], {
    env: { ...process.env, DATABASE_URL },
    stdio: "pipe",
  });
}

export default function setup() {
  const file = databaseFile(DATABASE_URL);
  remove(file);

  // Set before the push so prisma.config.ts leaves it alone, and before any
  // test imports src/lib/db.ts, which reads it at module load.
  process.env.DATABASE_URL = DATABASE_URL;

  // Run the Prisma CLI's entrypoint through Node directly. Going via `npx`
  // needs a shell on Windows (a .cmd cannot be spawned without one), and
  // spawning through a shell is both deprecated and an injection risk.
  const prismaCli = createRequire(import.meta.url).resolve(
    "prisma/build/index.js",
  );

  // Keep the SQLite schema current with the authored Postgres one, then make
  // sure both generated clients exist. Without the sync a schema change tested
  // here would pass against yesterday's tables.
  const root = process.cwd();
  execFileSync(process.execPath, [path.join(root, "scripts", "sync-sqlite-schema.mjs")], {
    stdio: "pipe",
  });
  ensureClient(root, "src/generated/sqlite", "prisma/schema.sqlite.prisma", prismaCli);
  ensureClient(root, "src/generated/prisma", "prisma/schema.prisma", prismaCli);

  // DATABASE_URL is a file: URL, so prisma.config.ts resolves this to the
  // SQLite schema on its own.
  execFileSync(process.execPath, [prismaCli, "db", "push"], {
    env: { ...process.env, DATABASE_URL },
    stdio: "pipe",
  });

  if (!fs.existsSync(file)) {
    throw new Error(
      `Prisma reported success but no database exists at ${file}. The test suite would run against nothing.`,
    );
  }

  return () => remove(file);
}
