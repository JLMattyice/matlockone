-- Send later.
--
-- An invoice can be given a day to go out on, and a repeat can send each of
-- its invoices itself. Three nullable columns on Invoice (the day, who to, who
-- chose it) and one on InvoiceSchedule that defaults to off. Every existing
-- invoice stays null, which means "sent by hand", and every existing repeat
-- keeps making drafts to check — nothing goes out that did not before. A
-- desktop copy gains them on launch.

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "sendOn" TIMESTAMP(3),
ADD COLUMN     "sendScheduledById" TEXT,
ADD COLUMN     "sendTo" TEXT;

-- AlterTable
ALTER TABLE "InvoiceSchedule" ADD COLUMN     "autoSend" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "Invoice_sendOn_idx" ON "Invoice"("sendOn");
