-- Job threads, and photos in them.
--
-- A nullable column on Conversation, and a table for the photo link. The
-- desktop launcher adds both to an install upgraded from 0.4.0, which shipped
-- Conversation without the column — but SQLite cannot add a foreign key to an
-- existing table, so there the column has no key behind it and deleteJob
-- removes a job's thread itself. The photo link is a table of its own for the
-- same reason: a new table arrives with its keys, a new column does not.

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "jobId" TEXT;

-- CreateTable
CREATE TABLE "MessageAttachment" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "attachmentId" TEXT NOT NULL,

    CONSTRAINT "MessageAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MessageAttachment_attachmentId_key" ON "MessageAttachment"("attachmentId");

-- CreateIndex
CREATE INDEX "MessageAttachment_messageId_idx" ON "MessageAttachment"("messageId");

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_jobId_key" ON "Conversation"("jobId");

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageAttachment" ADD CONSTRAINT "MessageAttachment_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageAttachment" ADD CONSTRAINT "MessageAttachment_attachmentId_fkey" FOREIGN KEY ("attachmentId") REFERENCES "Attachment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

