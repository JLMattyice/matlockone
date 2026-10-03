-- My Day: the day clock, and phones signed up for push notifications.
--
-- Two new tables. ClockEntry holds when each person started and stopped
-- work (no location, by the owner's choice); a job timer needs nothing new,
-- as it is a TimeEntry left open while it runs. PushSubscription holds each
-- device that asked for notifications. Nothing existing changes, and a
-- desktop copy gains the tables on launch.

-- CreateTable
CREATE TABLE "ClockEntry" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "clockedInAt" TIMESTAMP(3) NOT NULL,
    "clockedOutAt" TIMESTAMP(3),
    "editedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ClockEntry_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "PushSubscription" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PushSubscription_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE INDEX "ClockEntry_organizationId_clockedInAt_idx" ON "ClockEntry"("organizationId", "clockedInAt");
-- CreateIndex
CREATE INDEX "ClockEntry_userId_clockedInAt_idx" ON "ClockEntry"("userId", "clockedInAt");
-- CreateIndex
CREATE UNIQUE INDEX "PushSubscription_endpoint_key" ON "PushSubscription"("endpoint");
-- CreateIndex
CREATE INDEX "PushSubscription_userId_idx" ON "PushSubscription"("userId");
-- AddForeignKey
ALTER TABLE "ClockEntry" ADD CONSTRAINT "ClockEntry_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "ClockEntry" ADD CONSTRAINT "ClockEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "ClockEntry" ADD CONSTRAINT "ClockEntry_editedById_fkey" FOREIGN KEY ("editedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "PushSubscription" ADD CONSTRAINT "PushSubscription_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "PushSubscription" ADD CONSTRAINT "PushSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
