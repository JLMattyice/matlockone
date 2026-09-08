import fs from "node:fs";
import path from "node:path";

/**
 * Bootstrap for the CLI scripts. Import it first, before anything else.
 *
 * Two things have to happen before application modules load, and both are
 * ordering problems that produce confusing errors when missed.
 *
 * 1. `.env` must be read before `src/lib/db.ts`, which reads DATABASE_URL at
 *    import time. A script that calls loadEnvFile() in its own body has already
 *    imported the database module by the time that line runs, and fails with
 *    "DATABASE_URL is not set" while looking straight at a .env that has it.
 *
 * 2. `server-only` must be neutralised. It exists to turn "this module reached
 *    a client bundle" into a build error, and it does that by throwing on
 *    import. A command-line script is not a client bundle, but it trips the
 *    same wire — so anything reaching the email or licence modules dies on an
 *    error about React Server Components. The test runner solves this with a
 *    vitest alias; this is the same move for scripts.
 */

const envFile = path.join(process.cwd(), ".env");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

// Pre-seeding the require cache means the real module never executes, so its
// throw never happens. Guarded, because a resolution failure here should not
// take down a script that was never going to import it.
try {
  const resolved = require.resolve("server-only");
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: {},
  } as NodeJS.Module;
} catch {
  // Not installed, or resolved differently. Either way there is nothing to stub.
}
