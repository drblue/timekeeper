BEGIN;

ALTER TABLE "Entry" ADD COLUMN "invoiceDate" TEXT;
ALTER TABLE "Entry" ADD COLUMN "invoiceReference" TEXT;

COMMIT;
