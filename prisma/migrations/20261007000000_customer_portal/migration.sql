-- The customer portal and the public "Request service" form.
--
-- A nullable, unique portal token per customer, made the first time it is
-- needed, and a switch on the business for taking requests online (on by
-- default). Nothing already written changes.

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "requestsEnabled" BOOLEAN NOT NULL DEFAULT true;
-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "portalToken" TEXT;
-- CreateIndex
CREATE UNIQUE INDEX "Client_portalToken_key" ON "Client"("portalToken");
