-- Where the "ask for a review" email sends customers.
--
-- One nullable column on the business. Nothing already written changes.

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "reviewUrl" TEXT;
