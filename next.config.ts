import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { NextConfig } from "next";

const { version } = createRequire(import.meta.url)("./package.json") as {
  version: string;
};

/**
 * When this build was made.
 *
 * Baked in at compile time and shown under Settings, because "have you
 * installed the fix yet?" cost three round trips to answer once. A version
 * number would not have helped — it never changes between these builds — but a
 * date does, and it is the one thing that tells you whether the app running in
 * front of you contains the change being discussed.
 */
const BUILT_AT = new Date().toISOString();

/** This directory, which is the project — see outputFileTracingRoot below. */
const PROJECT_ROOT = path.dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  env: { BUILD_TIME: BUILT_AT, BUILD_VERSION: version },

  // Where file tracing considers the top of the world to be.
  //
  // Left unset, Next infers it by looking upwards for lockfiles, and picks the
  // highest one it finds. A stray package-lock.json in a parent directory —
  // someone's home folder, or a Desktop where an `npm install` was once run in
  // the wrong place — therefore silently becomes the root, and the standalone
  // output gets nested under the project's own directory name to preserve the
  // path relative to it. server.js then is not where it is expected to be, and
  // scripts/after-pack.cjs fails with "Packaged app is missing
  // resources/server/server.js" — several steps away from the lockfile that
  // actually caused it.
  //
  // Next warns about this, and the warning scrolls past in the middle of a
  // build. Pinning it is one line and cannot be got wrong by a file nobody
  // knew was there.
  outputFileTracingRoot: PROJECT_ROOT,

  // The Prisma client is generated into src/generated and must stay external
  // to the server bundle so its query engine resolves at runtime.
  serverExternalPackages: [
    "@prisma/client",
    "better-sqlite3",
    "@prisma/adapter-better-sqlite3",
  ],
  typedRoutes: false,

  // Emits .next/standalone: a self-contained server plus only the node_modules
  // it actually traced. That directory is what the desktop build ships, so the
  // installer does not carry the whole dev dependency tree.
  //
  // Only for that build. A hosted deployment builds its own server and has no
  // use for the tree — on Vercel it is at best wasted work during every deploy,
  // and standalone's traced copy is not what actually gets served there.
  // scripts/build-desktop.mjs sets the flag.
  ...(process.env.MATLOCK_DESKTOP_BUILD
    ? {
        output: "standalone" as const,

        // src/lib/db.ts loads the SQLite adapter with require() at the point of
        // use rather than importing it, so that a hosted deployment never
        // evaluates a native module it will not use. The cost is that nothing
        // statically references it any more, and tracing works by following
        // static references — so the desktop bundle would ship without the one
        // adapter it actually needs. Named here instead.
        //
        // driver-adapter-utils is listed too: it is the adapter's own
        // dependency, and an include is not a trace.
        outputFileTracingIncludes: {
          "*": [
            "./node_modules/@prisma/adapter-better-sqlite3/**",
            "./node_modules/@prisma/driver-adapter-utils/**",
          ],
        },
      }
    : {}),
};

export default nextConfig;
