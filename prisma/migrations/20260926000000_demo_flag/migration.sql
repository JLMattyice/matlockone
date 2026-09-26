-- The shared sample business, which can be looked at and not changed.
--
-- A flag rather than a match on the demo's slug or name: sign-up turns a
-- business name into a slug, so a real "Northside Home Services" could
-- otherwise arrive read-only on a deployment that had no demo seeded yet.

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "isDemo" BOOLEAN NOT NULL DEFAULT false;
