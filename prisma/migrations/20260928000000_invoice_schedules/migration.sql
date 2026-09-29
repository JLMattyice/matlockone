-- Repeating invoices: a schedule, and which series each invoice belongs to.
--
-- The schedule carries no line items. Each period the morning run copies the
-- latest invoice in the series into a new draft, so the series is the pattern
-- and a price changed on one invoice carries forward. Only new things are
-- added here — a nullable column and a new table — so nothing already written
-- changes and a desktop copy can take it without a backfill.

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "scheduleId" TEXT;

-- CreateTable
CREATE TABLE "InvoiceSchedule" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "frequency" TEXT NOT NULL DEFAULT 'MONTHLY',
    "interval" INTEGER NOT NULL DEFAULT 1,
    "anchorDate" TIMESTAMP(3) NOT NULL,
    "nextIssueDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InvoiceSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InvoiceSchedule_isActive_nextIssueDate_idx" ON "InvoiceSchedule"("isActive", "nextIssueDate");

-- CreateIndex
CREATE INDEX "InvoiceSchedule_organizationId_idx" ON "InvoiceSchedule"("organizationId");

-- CreateIndex
CREATE INDEX "Invoice_scheduleId_idx" ON "Invoice"("scheduleId");

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "InvoiceSchedule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceSchedule" ADD CONSTRAINT "InvoiceSchedule_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceSchedule" ADD CONSTRAINT "InvoiceSchedule_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
