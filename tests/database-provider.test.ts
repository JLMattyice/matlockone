import { afterEach, describe, expect, it, vi } from "vitest";

import { providerFor } from "@/lib/db-provider";

/**
 * Matlock One runs on Postgres hosted and SQLite on the desktop, from one set
 * of queries. Two things follow from that and neither is visible in normal use,
 * which is why they are pinned here.
 */

describe("providerFor", () => {
  it("reads Postgres from either accepted scheme", () => {
    expect(providerFor("postgresql://u:p@host:5432/db")).toBe("postgresql");
    expect(providerFor("postgres://u:p@host:5432/db")).toBe("postgresql");
  });

  it("reads SQLite from a file URL", () => {
    expect(providerFor("file:./dev.db")).toBe("sqlite");
    expect(providerFor("file:C:/Users/x/AppData/Local/Matlock One/matlockone.db")).toBe(
      "sqlite",
    );
  });

  it("tolerates surrounding whitespace, which .env files collect", () => {
    expect(providerFor("  postgresql://u:p@host/db  ")).toBe("postgresql");
  });

  it("refuses an unknown scheme rather than guessing", () => {
    // Guessing here picks the wrong driver adapter, and that failure surfaces
    // much later as an unintelligible protocol error.
    expect(() => providerFor("mysql://u:p@host/db")).toThrow(/unsupported scheme/i);
  });

  it("says what to do when it is missing entirely", () => {
    expect(() => providerFor(undefined)).toThrow(/DATABASE_URL is not set/);
    expect(() => providerFor("   ")).toThrow(/DATABASE_URL is not set/);
  });
});

describe("like()", () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  /**
   * The regression this guards against is silent. SQLite's LIKE is
   * case-insensitive for ASCII, so every search box in the app has always
   * matched "Smith" for "smith". Postgres LIKE is case-sensitive: without
   * `mode`, the same query half-works, and it reads to a customer like their
   * records have gone missing.
   */
  it("asks Postgres for case-insensitive matching", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://u:p@host:5432/db");
    vi.resetModules();
    const { like } = await import("@/lib/search");

    expect(like("smith")).toEqual({ contains: "smith", mode: "insensitive" });
  });

  it("omits mode on SQLite, which has no such key", async () => {
    // Prisma only generates `mode` for providers that support it, so sending it
    // to SQLite is not a no-op — it is a rejected query.
    vi.stubEnv("DATABASE_URL", "file:./dev.db");
    vi.resetModules();
    const { like } = await import("@/lib/search");

    expect(like("smith")).toEqual({ contains: "smith" });
    expect(like("smith")).not.toHaveProperty("mode");
  });
});
