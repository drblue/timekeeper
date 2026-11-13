BEGIN;

ALTER TABLE "Entry" ADD COLUMN "invoiceNumber" TEXT;
CREATE INDEX "Entry_accountId_invoicedAt_idx" ON "Entry"("accountId", "invoicedAt");
CREATE INDEX "EntryDayAllocation_localDate_entryId_idx" ON "EntryDayAllocation"("localDate", "entryId");

COMMIT;
