-- Matlock One's colour is now green, to match its icon.
--
-- A business that never picked a colour of its own is still on the old blue
-- default, and moves with the product. One that picked something else keeps
-- it. The demo moves too: it is how the product is shown.

-- AlterTable
ALTER TABLE "Organization" ALTER COLUMN "primaryColor" SET DEFAULT '#1d7c5c';

UPDATE "Organization"
SET "primaryColor" = '#1d7c5c'
WHERE lower("primaryColor") = '#2563eb' OR "isDemo" = true;
