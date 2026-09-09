import { PrismaClient } from "@/generated/prisma/client";
import { PrismaClient as SqlitePrismaClient } from "@/generated/sqlite/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";

import { databaseProvider } from "./db-provider";

/**
 * The database connection, on whichever database this deployment runs.
 *
 * Matlock One ships twice from one codebase: hosted on Postgres, and on the
 * desktop where the business's records are a SQLite file on their own machine.
 * Prisma 7 talks to both through a driver adapter, so the choice is confined to
 * this file — no query anywhere else in the app knows which one it is talking
 * to.
 *
 * Two generated clients rather than one, because Prisma tags a client with the
 * provider it was generated for and will not accept a mismatched adapter. They
 * are generated from the same models (see scripts/sync-sqlite-schema.mjs), so
 * they are structurally identical and the Postgres one supplies the types the
 * whole application is written against.
 */

/**
 * Builds a client for whichever database DATABASE_URL points at.
 *
 * Exported because the integration tests open their own connection — they are
 * testing transactions against a real database, so they cannot share the
 * request-scoped singleton — and adapter selection must not be written out a
 * second time in the test suite to drift from this one.
 */
export function createPrismaClient(): PrismaClient {
  const url = process.env.DATABASE_URL as string;
  const provider = databaseProvider(url);

  const log =
    process.env.NODE_ENV === "development"
      ? (["warn", "error"] as const)
      : (["error"] as const);

  if (provider === "sqlite") {
    // The two clients differ only in the provider they were generated for, so
    // this is safe — but it is a cast, and it is here rather than at a call
    // site so that the rest of the app never has to know there are two.
    return new SqlitePrismaClient({
      adapter: new PrismaBetterSqlite3({ url }),
      log: [...log],
    }) as unknown as PrismaClient;
  }

  return new PrismaClient({
    adapter: new PrismaPg({ connectionString: url, max: poolMax() }),
    log: [...log],
  });
}

/**
 * How many Postgres connections one instance of this process may hold.
 *
 * On a serverless host the arithmetic runs the wrong way: instances multiply
 * under load, each opening its own pool, and Postgres runs out of connections
 * long before the application runs out of capacity. A small per-instance pool
 * behind a connection pooler is the shape that survives — which is also why
 * DATABASE_URL should be the *pooled* connection string on Vercel, and why
 * migrations use DIRECT_DATABASE_URL instead.
 *
 * Generous elsewhere: a desktop install or a single long-running server has one
 * process and nothing to starve.
 */
function poolMax() {
  const configured = Number(process.env.DATABASE_POOL_MAX);
  if (Number.isFinite(configured) && configured > 0) return Math.trunc(configured);

  return process.env.VERCEL ? 3 : 10;
}

// Next.js dev server hot-reloads modules; without the global cache every reload
// would open another connection pool.
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
