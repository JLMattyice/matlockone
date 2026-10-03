-- A customer's electronic signature on an estimate they accept online.
--
-- Six nullable columns: the typed name, when, the IP address and browser it
-- came from, and a hash and snapshot of exactly what was signed. Nothing
-- already written changes, and a desktop copy takes them without a backfill.

-- AlterTable
ALTER TABLE "Estimate" ADD COLUMN     "signedName" TEXT,
ADD COLUMN     "signedAt" TIMESTAMP(3),
ADD COLUMN     "signedIp" TEXT,
ADD COLUMN     "signedUserAgent" TEXT,
ADD COLUMN     "signedHash" TEXT,
ADD COLUMN     "signedSnapshot" TEXT;
