-- Auto-pay for repeating invoices: the customer approves a PayPal
-- subscription once and is charged each period.
--
-- The schedule gains the invite's token and the PayPal plan offered; each
-- subscription PayPal makes for it is a row of its own, because a stale
-- approval link means a customer can be given more than one, and every one
-- has to be watched so a second approval is caught and cancelled. Only new
-- nullable columns and a new table, so nothing already written changes and a
-- desktop copy can take it without a backfill.

-- AlterTable
ALTER TABLE "InvoiceSchedule" ADD COLUMN     "autopayAmountCents" INTEGER,
ADD COLUMN     "autopayOfferedAt" TIMESTAMP(3),
ADD COLUMN     "autopayPlanId" TEXT,
ADD COLUMN     "autopayToken" TEXT;

-- CreateTable
CREATE TABLE "AutopaySubscription" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "scheduleId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'PAYPAL',
    "externalId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'APPROVAL_PENDING',
    "approveUrl" TEXT,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "payerEmail" TEXT,
    "checkedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutopaySubscription_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AutopaySubscription_scheduleId_idx" ON "AutopaySubscription"("scheduleId");

-- CreateIndex
CREATE INDEX "AutopaySubscription_status_idx" ON "AutopaySubscription"("status");

-- CreateIndex
CREATE UNIQUE INDEX "AutopaySubscription_organizationId_provider_externalId_key" ON "AutopaySubscription"("organizationId", "provider", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceSchedule_autopayToken_key" ON "InvoiceSchedule"("autopayToken");

-- AddForeignKey
ALTER TABLE "AutopaySubscription" ADD CONSTRAINT "AutopaySubscription_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutopaySubscription" ADD CONSTRAINT "AutopaySubscription_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "InvoiceSchedule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

