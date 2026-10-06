-- Payment edits.
--
-- A payment can now be corrected after it is recorded. One nullable column
-- remembers when, so QuickBooks sync knows to send the change; every existing
-- payment stays null, which means "never edited", and nothing is re-sent. A
-- desktop copy gains the column on launch.

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "editedAt" TIMESTAMP(3);
