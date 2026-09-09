/**
 * Which database this process is talking to.
 *
 * Matlock One runs on Postgres when hosted and on SQLite on the desktop, from
 * one set of queries. Almost nothing needs to know the difference — Prisma
 * hides it — but the few things that do must all agree, so they derive it here
 * rather than each sniffing the URL their own way.
 *
 * Deliberately free of `server-only`: the tests import this directly, and it
 * reads one environment variable and touches nothing else.
 */

export type DbProvider = "postgresql" | "sqlite";

/**
 * Reads the provider out of a connection string.
 *
 * Throws on anything unrecognised rather than assuming. Guessing wrong here
 * means picking the wrong driver adapter, and the failure that produces
 * surfaces much further away as an unintelligible protocol error.
 */
export function providerFor(url: string | undefined): DbProvider {
  if (!url || !url.trim()) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env.\n" +
        "  Postgres: postgresql://user:password@host:5432/matlockone\n" +
        "  SQLite:   file:./dev.db",
    );
  }

  const trimmed = url.trim();
  if (trimmed.startsWith("file:")) return "sqlite";
  if (/^postgres(ql)?:\/\//.test(trimmed)) return "postgresql";

  // Never widen this to a default. An unparsed URL is a misconfiguration, and
  // saying so now is far cheaper than a driver mismatch at the first query.
  throw new Error(
    `DATABASE_URL has an unsupported scheme: ${trimmed.split(":")[0]}:\n` +
      "Expected a postgresql:// URL (hosted) or a file: path (desktop).",
  );
}

export function databaseProvider(
  url: string | undefined = process.env.DATABASE_URL,
): DbProvider {
  return providerFor(url);
}
