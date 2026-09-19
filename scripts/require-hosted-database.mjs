import fs from "node:fs";
import path from "node:path";

/**
 * Refuses `db:deploy` unless it is pointed at the hosted database.
 *
 * Migrations exist for the hosted Postgres. The desktop build creates its
 * SQLite file from DDL and adds missing columns on start, and local
 * development uses `db:push`, so neither has a migration history — which is
 * what `prisma migrate deploy` needs.
 *
 * Without this, running `npm run db:deploy` with the usual development `.env`
 * reads `DATABASE_URL="file:./dev.db"`, reaches the local file, and fails with
 * P3005 "the database schema is not empty" plus a link about baselining a
 * production database. Every word of that is about a database the command
 * should never have touched, and it says nothing about the credentials that
 * were actually missing.
 *
 * The rule is both settings, not just the one that connects:
 *
 * - `DATABASE_URL` decides which *schema* prisma.config.ts loads, by whether
 *   it starts with `file:`. Leave it on dev.db and the CLI loads the SQLite
 *   schema.
 * - `DIRECT_DATABASE_URL`, when set, decides what it *connects* to.
 *
 * Set only the second and the CLI takes the SQLite schema to Postgres, which
 * is a worse failure than the one this replaces: the destination is real.
 */

// Mirrors prisma.config.ts exactly: an explicitly-set DATABASE_URL wins, and
// .env fills in only when there is none. The guard has to see what the CLI
// will see, or it passes on a value the CLI never uses.
const envFile = path.join(process.cwd(), ".env");
if (!process.env.DATABASE_URL && fs.existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

const isLocalFile = (value) => value.trim().startsWith("file:");

const databaseUrl = process.env.DATABASE_URL?.trim() ?? "";
const directUrl = process.env.DIRECT_DATABASE_URL?.trim() ?? "";

function refuse(problem) {
  console.error(`\nmigrate deploy: ${problem}\n`);
  console.error(
    "This command applies migrations to the hosted Postgres database, so it",
  );
  console.error(
    "needs that database's direct connection string — Supabase's Connect",
  );
  console.error("panel, port 5432, not the 6543 pooler.\n");
  console.error("  PowerShell:");
  console.error('    $env:DATABASE_URL="postgresql://…:5432/postgres"');
  console.error("    npm run db:deploy");
  console.error("    Remove-Item Env:DATABASE_URL\n");
  console.error("  bash:");
  console.error('    DATABASE_URL="postgresql://…:5432/postgres" npm run db:deploy\n');
  console.error(
    "Local development does not use migrations at all: `npm run db:push`",
  );
  console.error("applies the schema to dev.db. See DEPLOY.md.\n");
  process.exit(1);
}

if (!databaseUrl && !directUrl) {
  refuse("neither DATABASE_URL nor DIRECT_DATABASE_URL is set.");
}

if (databaseUrl && isLocalFile(databaseUrl)) {
  refuse(
    directUrl && !isLocalFile(directUrl)
      ? "DIRECT_DATABASE_URL points at a hosted database, but DATABASE_URL is " +
          "still a local file — which is what selects the SQLite schema."
      : "DATABASE_URL is a local SQLite file.",
  );
}

if (directUrl && isLocalFile(directUrl)) {
  refuse("DIRECT_DATABASE_URL is a local SQLite file.");
}
