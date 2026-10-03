-- Job checklists.
--
-- Two new tables: the checklists a business reuses (optionally put on a
-- category's jobs by themselves), and each job's own items, ticked off in
-- the field. Nothing existing changes, and a desktop copy gains the tables
-- on launch.

-- CreateTable
CREATE TABLE "ChecklistTemplate" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "items" TEXT NOT NULL,
    "kind" TEXT,
    "categoryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ChecklistTemplate_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "JobChecklistItem" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "doneAt" TIMESTAMP(3),
    "doneById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "JobChecklistItem_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE INDEX "ChecklistTemplate_organizationId_idx" ON "ChecklistTemplate"("organizationId");
-- CreateIndex
CREATE INDEX "JobChecklistItem_jobId_idx" ON "JobChecklistItem"("jobId");
-- AddForeignKey
ALTER TABLE "ChecklistTemplate" ADD CONSTRAINT "ChecklistTemplate_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "ChecklistTemplate" ADD CONSTRAINT "ChecklistTemplate_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "JobCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "JobChecklistItem" ADD CONSTRAINT "JobChecklistItem_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "JobChecklistItem" ADD CONSTRAINT "JobChecklistItem_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "JobChecklistItem" ADD CONSTRAINT "JobChecklistItem_doneById_fkey" FOREIGN KEY ("doneById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
