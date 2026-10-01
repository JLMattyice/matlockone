-- A private calendar feed per person: the token in the address a calendar
-- app subscribes to. Nullable and unset for everybody until they turn the
-- feed on, so nothing already written changes and a desktop copy can take
-- it without a backfill.

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "calendarFeedToken" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "User_calendarFeedToken_key" ON "User"("calendarFeedToken");
