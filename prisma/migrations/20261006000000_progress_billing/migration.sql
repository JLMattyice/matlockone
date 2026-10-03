-- Deposits and progress billing.
--
-- An estimate can ask for a deposit on acceptance; an invoice can be one
-- stage of billing a job in parts, and a final invoice carries a credit for
-- what was billed before it. Every new column has a default, so nothing
-- already written changes and a desktop copy takes them without a backfill.

-- AlterTable
ALTER TABLE "Estimate" ADD COLUMN     "depositCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "depositType" TEXT NOT NULL DEFAULT 'NONE',
ADD COLUMN     "depositValue" INTEGER NOT NULL DEFAULT 0;
-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "billingStage" TEXT,
ADD COLUMN     "creditCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "creditLabel" TEXT;
