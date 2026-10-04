-- Bills on the calendar.
--
-- One setting: which roles see repeating bills on the schedule on the dates
-- they come due. Owners, admins and managers to start — the roles that can
-- already see expenses. Nothing else changes; a desktop copy gains the
-- column on launch.

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "billsOnCalendarRoles" TEXT NOT NULL DEFAULT 'OWNER,ADMIN,MANAGER';
