-- Banning a business from the Accounts page.
--
-- Two nullable columns on Organization: when the operator closed it for
-- breaking the terms, and the reason they gave. Every existing business stays
-- null on both, which is what it already was — open. A desktop copy gains
-- them on launch.

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "bannedAt" TIMESTAMP(3),
ADD COLUMN     "banReason" TEXT;
