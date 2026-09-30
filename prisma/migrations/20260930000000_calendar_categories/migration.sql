-- Calendar categories a business makes for itself, and built-in ones it can
-- take out of the picker.
--
-- An entry in a custom category still carries the built-in kind it behaves
-- as, so the category only names it and picks its mark; deleting a category
-- sets the link to null and the entry reads as that kind again. Only a new
-- table, a nullable column and a column with a literal default, so nothing
-- already written changes and a desktop copy can take it without a backfill.

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "hiddenJobKinds" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "Job" ADD COLUMN     "categoryId" TEXT;

-- CreateTable
CREATE TABLE "JobCategory" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "icon" TEXT NOT NULL DEFAULT 'tag',
    "kind" TEXT NOT NULL DEFAULT 'OTHER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobCategory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "JobCategory_organizationId_idx" ON "JobCategory"("organizationId");

-- CreateIndex
CREATE INDEX "Job_categoryId_idx" ON "Job"("categoryId");

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "JobCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobCategory" ADD CONSTRAINT "JobCategory_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

