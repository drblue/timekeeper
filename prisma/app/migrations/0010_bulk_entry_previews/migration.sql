CREATE TABLE "BulkEntryPreview" (
	"id" TEXT NOT NULL PRIMARY KEY,
	"accountId" TEXT NOT NULL,
	"snapshot" TEXT NOT NULL,
	"expiresAt" DATETIME NOT NULL,
	"consumedAt" DATETIME,
	CONSTRAINT "BulkEntryPreview_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "BulkEntryPreview_accountId_expiresAt_idx" ON "BulkEntryPreview"("accountId", "expiresAt");
