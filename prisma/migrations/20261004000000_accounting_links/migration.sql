-- Where each record went in an accounting package.
--
-- One new table: a customer here and the QuickBooks Online customer it was
-- sent as, so a later edit updates that customer instead of making another.
-- Nothing existing changes, and a desktop copy gains the table on launch.

-- CreateTable
CREATE TABLE "AccountingLink" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "realmId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "externalId" TEXT,
    "syncToken" TEXT,
    "origin" TEXT NOT NULL DEFAULT 'CREATED',
    "syncedAt" TIMESTAMP(3),
    "lastTriedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountingLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AccountingLink_organizationId_provider_entityType_idx" ON "AccountingLink"("organizationId", "provider", "entityType");

-- CreateIndex
CREATE UNIQUE INDEX "AccountingLink_provider_realmId_entityType_entityId_key" ON "AccountingLink"("provider", "realmId", "entityType", "entityId");

-- AddForeignKey
ALTER TABLE "AccountingLink" ADD CONSTRAINT "AccountingLink_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
