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
