-- Terminology beyond jobs and clients, plus the preset it came from.
--
-- Every column is NOT NULL with a default, so existing rows keep exactly the
-- words they show today: an organization that has been calling them Estimates
-- and Leads goes on doing so, and GENERAL is the preset whose labels are those
-- same defaults. Nothing here changes what anyone sees until they choose a
-- business type or edit a label.

-- AlterTable
ALTER TABLE "Organization"
    ADD COLUMN "businessType" TEXT NOT NULL DEFAULT 'GENERAL',
    ADD COLUMN "labelEstimateSingular" TEXT NOT NULL DEFAULT 'Estimate',
    ADD COLUMN "labelEstimatePlural" TEXT NOT NULL DEFAULT 'Estimates',
    ADD COLUMN "labelLeadSingular" TEXT NOT NULL DEFAULT 'Lead',
    ADD COLUMN "labelLeadPlural" TEXT NOT NULL DEFAULT 'Leads';
