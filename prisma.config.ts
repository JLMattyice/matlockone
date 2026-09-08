import path from "node:path";
import fs from "node:fs";
import { defineConfig, env } from "prisma/config";

// Prisma 7 no longer reads .env automatically. Next.js loads it for the app
// itself; this covers the CLI (generate / db push / seed / studio).
//
// An explicitly-set DATABASE_URL wins, so the test harness can point the CLI at
// a throwaway database without .env pulling it back to dev.db.
const envFile = path.join(process.cwd(), ".env");
if (!process.env.DATABASE_URL && fs.existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

export default defineConfig({
  schema: path.join("prisma", "schema.prisma"),
  migrations: {
    path: path.join("prisma", "migrations"),
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: env("DATABASE_URL"),
  },
});
