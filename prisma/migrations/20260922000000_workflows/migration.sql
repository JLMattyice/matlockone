-- Automations: which ones a business has turned on, and what each has fired for.
--
-- The catalog of automations lives in code; a Workflow row says which one is
-- on and with what numbers. WorkflowRun records that one has already fired for
-- one particular invoice or client, because firing twice for the same thing is
-- how people learn to ignore the tasks an automation makes.

-- CreateTable
CREATE TABLE "Workflow" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "config" TEXT,
    "lastRunAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Workflow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowRun" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "summary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkflowRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Workflow_organizationId_templateId_key" ON "Workflow"("organizationId", "templateId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowRun_workflowId_entityType_entityId_key" ON "WorkflowRun"("workflowId", "entityType", "entityId");

-- CreateIndex
CREATE INDEX "WorkflowRun_organizationId_createdAt_idx" ON "WorkflowRun"("organizationId", "createdAt");

-- AddForeignKey
ALTER TABLE "Workflow" ADD CONSTRAINT "Workflow_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Workflow" ADD CONSTRAINT "Workflow_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowRun" ADD CONSTRAINT "WorkflowRun_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowRun" ADD CONSTRAINT "WorkflowRun_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "Workflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;
