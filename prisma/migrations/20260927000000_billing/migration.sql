-- Subscriptions, attached to the business rather than emailed as a key.
--
-- The hosted app stops having a free tier: a business is open while it has
-- paid through today (with a few days' grace), is the demo, or is exempt.
-- The desktop build keeps paying by licence key and leaves these empty.

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "billingExempt" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "paidThrough" TIMESTAMP(3),
ADD COLUMN     "subscriptionId" TEXT,
ADD COLUMN     "subscriptionInterval" TEXT,
ADD COLUMN     "subscriptionPlan" TEXT,
ADD COLUMN     "subscriptionStatus" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Organization_subscriptionId_key" ON "Organization"("subscriptionId");

