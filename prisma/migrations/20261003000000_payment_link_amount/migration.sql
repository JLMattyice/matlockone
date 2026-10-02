-- What a pay link asks for.
--
-- A processor link (PayPal, Stripe, Square, Shopify) is made for the balance at
-- that moment and never changes. Recording the amount lets Matlock One stop
-- offering a link once a part-payment or an edit has moved the balance. One
-- nullable column: nothing already written changes, and a desktop copy can
-- take it without a backfill.

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "paymentLinkCents" INTEGER;

