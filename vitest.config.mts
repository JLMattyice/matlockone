import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // tsconfig says "preserve", because Next compiles the JSX itself. The test
  // runner has no Next in front of it, so it is told to compile JSX the way
  // React 19 does — which is what lets a test render a page or a component.
  oxc: { jsx: { runtime: "automatic" } },
  resolve: {
    alias: {
      "@": path.resolve(root, "src"),
      // `server-only` throws on import outside a React Server Component
      // environment. The modules under test legitimately use it as a guard, so
      // it is stubbed out here rather than removed from the source.
      "server-only": path.resolve(root, "tests/support/empty.ts"),
    },
  },
  test: {
    environment: "node",
    globalSetup: ["./tests/support/global-setup.ts"],
    // The invoice-balance suite shares one SQLite file. Running files in
    // parallel against it produces write contention, not real failures.
    fileParallelism: false,
    include: ["tests/**/*.test.ts"],
  },
});
