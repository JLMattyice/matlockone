import { createRequire } from "node:module";

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

const nextConfig: NextConfig = {
  env: { BUILD_TIME: BUILT_AT, BUILD_VERSION: version },

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
