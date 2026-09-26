import { afterEach, describe, expect, it, vi } from "vitest";

import { createPrismaClient } from "@/lib/db";

/**
 * The connection the whole application runs on.
 *
 * A DATABASE_URL pasted into a hosting dashboard can arrive with a space or a
 * line break around it. Postgres takes a trailing one as part of the database
 * name, so the site fails on every page that reads data, while the Prisma CLI,
 * which trims, connects happily with the same value.
 */

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("createPrismaClient", () => {
  it("ignores a space or line break around DATABASE_URL", async () => {
    vi.stubEnv("DATABASE_URL", `  ${process.env.DATABASE_URL}\r\n`);

    const client = createPrismaClient();
    try {
      await expect(client.organization.count()).resolves.toBeGreaterThanOrEqual(0);
    } finally {
      await client.$disconnect();
    }
  });
});
