-- Free-month codes.
--
-- One new table for the codes the operator makes on the Accounts page, and
-- two nullable columns on Organization: the code a business entered, and when
-- the free month PayPal gave it ends. Every existing business stays null on
-- both, which is what it already was — no code, no free month. A desktop copy
-- gains them on launch.

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "trialCodeId" TEXT,
ADD COLUMN     "trialEndsAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "TrialCode" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "note" TEXT,
    "maxUses" INTEGER,
    "expiresAt" TIMESTAMP(3),
    "disabledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrialCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TrialCode_code_key" ON "TrialCode"("code");

-- CreateIndex
CREATE INDEX "Organization_trialCodeId_idx" ON "Organization"("trialCodeId");

-- AddForeignKey
ALTER TABLE "Organization" ADD CONSTRAINT "Organization_trialCodeId_fkey" FOREIGN KEY ("trialCodeId") REFERENCES "TrialCode"("id") ON DELETE SET NULL ON UPDATE CASCADE;
