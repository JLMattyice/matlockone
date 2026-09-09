import { databaseProvider } from "./db-provider";

/**
 * Case-insensitive substring matching, on either database.
 *
 * This exists because of a difference that is otherwise invisible until a
 * customer reports it. SQLite's LIKE is case-insensitive for ASCII, so
 * `{ contains: "smith" }` has always found "Smith". Postgres LIKE is case-
 * sensitive, and the same clause silently stops matching — every search box in
 * the app quietly half-works, and it reads to the user like their records are
 * gone.
 *
 * Postgres takes `mode: "insensitive"` to get SQLite's behaviour back. SQLite
 * rejects that key, because Prisma only generates it for providers that
 * support it. So neither spelling is portable and the choice has to be made at
 * runtime, in one place, rather than at 69 call sites.
 */

/**
 * Resolved once at module load. The provider cannot change under a running
 * process, and re-reading the environment per clause would put a string parse
 * inside every search query.
 */
const INSENSITIVE = databaseProvider() === "postgresql"
  ? ({ mode: "insensitive" } as const)
  : null;

/**
 * `where: { displayName: like(q) }`
 *
 * Returns the filter object, not just the flag, so a call site cannot forget
 * the `mode` half — that is the whole point of routing through here.
 */
export function like(value: string) {
  return INSENSITIVE
    ? { contains: value, ...INSENSITIVE }
    : { contains: value };
}
