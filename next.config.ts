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
  serverExternalPackages: ["@prisma/client", "better-sqlite3"],
  typedRoutes: false,

  // Emits .next/standalone: a self-contained server plus only the node_modules
  // it actually traced. That directory is what the desktop build ships, so the
  // installer does not carry the whole dev dependency tree.
  output: "standalone",
};

export default nextConfig;
