-- Counters for the abuse limits on sign-in, sign-up and the pay redirect.
--
-- A row per thing being limited, holding a count and when the window closes.
-- Rows are disposable: losing the table costs nothing but a reset of every
-- window, and expired rows are swept as they are encountered.

-- CreateTable
CREATE TABLE "RateLimit" (
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "windowEnd" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateLimit_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "RateLimit_windowEnd_idx" ON "RateLimit"("windowEnd");
