CREATE TABLE "ClockifyImportAlias" (
	"accountId" TEXT NOT NULL,
	"fingerprint" TEXT NOT NULL,
	"occurrence" INTEGER NOT NULL CHECK ("occurrence" >= 1),
	"candidateKey" TEXT NOT NULL,
	"targetFingerprint" TEXT NOT NULL,
	"targetOccurrence" INTEGER NOT NULL,
	"batchId" TEXT NOT NULL,
	"resolution" TEXT NOT NULL CHECK ("resolution" IN ('keep', 'update')),
	"sourceSnapshot" TEXT NOT NULL,
	PRIMARY KEY ("accountId", "fingerprint", "occurrence"),
	CONSTRAINT "ClockifyImportAlias_target_fkey" FOREIGN KEY ("accountId", "targetFingerprint", "targetOccurrence") REFERENCES "ClockifyImportIdentity" ("accountId", "fingerprint", "occurrence") ON DELETE RESTRICT ON UPDATE CASCADE,
	CONSTRAINT "ClockifyImportAlias_batch_fkey" FOREIGN KEY ("accountId", "batchId") REFERENCES "ClockifyImportBatch" ("accountId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ClockifyImportAlias_accountId_fingerprint_targetFingerprint_targetOccurrence_key" ON "ClockifyImportAlias"("accountId", "fingerprint", "targetFingerprint", "targetOccurrence");
CREATE INDEX "ClockifyImportAlias_accountId_candidateKey_idx" ON "ClockifyImportAlias"("accountId", "candidateKey");
CREATE INDEX "ClockifyImportAlias_accountId_batchId_idx" ON "ClockifyImportAlias"("accountId", "batchId");
CREATE INDEX "ClockifyImportAlias_accountId_targetFingerprint_targetOccurrence_idx" ON "ClockifyImportAlias"("accountId", "targetFingerprint", "targetOccurrence");
