ALTER TABLE "ClockifyImportBatch" ADD COLUMN "undoneAt" DATETIME;
ALTER TABLE "ClockifyImportBatch" ADD COLUMN "undoSnapshot" TEXT;

CREATE TABLE "ClockifyReleasedIdentity" (
	"accountId" TEXT NOT NULL,
	"entryId" TEXT NOT NULL,
	"fingerprint" TEXT NOT NULL,
	"occurrence" INTEGER NOT NULL CHECK ("occurrence" >= 1),
	"candidateKey" TEXT NOT NULL,
	"batchId" TEXT NOT NULL,
	"entryRevision" INTEGER NOT NULL,
	"sourceSnapshot" TEXT NOT NULL,
	PRIMARY KEY ("accountId", "entryId"),
	CONSTRAINT "ClockifyReleasedIdentity_entry_fkey" FOREIGN KEY ("accountId", "entryId") REFERENCES "Entry" ("accountId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
	CONSTRAINT "ClockifyReleasedIdentity_batch_fkey" FOREIGN KEY ("accountId", "batchId") REFERENCES "ClockifyImportBatch" ("accountId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "ClockifyReleasedIdentity_accountId_batchId_idx" ON "ClockifyReleasedIdentity"("accountId", "batchId");
