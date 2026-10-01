-- Repeating expenses: rent, software, insurance, utilities.
--
-- A schedule, which series each expense belongs to, and which schedule a
-- "enter this month's bill" task is for. Like repeating invoices, the schedule
-- carries no amount: each period copies the latest expense in the series. Only
-- new things are added here — two nullable columns and a new table — so
-- nothing already written changes and a desktop copy can take it without a
-- backfill.

-- AlterTable
ALTER TABLE "Expense" ADD COLUMN     "scheduleId" TEXT;

-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "expenseScheduleId" TEXT;

-- CreateTable
CREATE TABLE "ExpenseSchedule" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "frequency" TEXT NOT NULL DEFAULT 'MONTHLY',
    "interval" INTEGER NOT NULL DEFAULT 1,
    "anchorDate" TIMESTAMP(3) NOT NULL,
    "nextDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "amountVaries" BOOLEAN NOT NULL DEFAULT false,
    "lastRunAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExpenseSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExpenseSchedule_isActive_nextDate_idx" ON "ExpenseSchedule"("isActive", "nextDate");

-- CreateIndex
CREATE INDEX "ExpenseSchedule_organizationId_idx" ON "ExpenseSchedule"("organizationId");

-- CreateIndex
CREATE INDEX "Expense_scheduleId_idx" ON "Expense"("scheduleId");

-- CreateIndex
CREATE INDEX "Task_expenseScheduleId_idx" ON "Task"("expenseScheduleId");

-- AddForeignKey
ALTER TABLE "ExpenseSchedule" ADD CONSTRAINT "ExpenseSchedule_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpenseSchedule" ADD CONSTRAINT "ExpenseSchedule_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "ExpenseSchedule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_expenseScheduleId_fkey" FOREIGN KEY ("expenseScheduleId") REFERENCES "ExpenseSchedule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

