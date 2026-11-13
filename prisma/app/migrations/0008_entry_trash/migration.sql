BEGIN;

ALTER TABLE "Entry" ADD COLUMN "deletedAt" DATETIME;
CREATE INDEX "Entry_accountId_deletedAt_idx" ON "Entry"("accountId", "deletedAt");

COMMIT;
