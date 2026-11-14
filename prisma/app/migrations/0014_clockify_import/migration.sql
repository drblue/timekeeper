CREATE TABLE "ClockifyImportStage" (
	"id" TEXT NOT NULL PRIMARY KEY,
	"accountId" TEXT NOT NULL,
	"expiresAt" DATETIME NOT NULL,
	"snapshot" TEXT NOT NULL,
	CONSTRAINT "ClockifyImportStage_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ClockifyImportStage_accountId_id_key" ON "ClockifyImportStage"("accountId", "id");
CREATE INDEX "ClockifyImportStage_accountId_expiresAt_idx" ON "ClockifyImportStage"("accountId", "expiresAt");

CREATE TABLE "ClockifyImportPreview" (
	"id" TEXT NOT NULL PRIMARY KEY,
	"accountId" TEXT NOT NULL,
	"stageId" TEXT NOT NULL,
	"expiresAt" DATETIME NOT NULL,
	"decisions" TEXT NOT NULL,
	"planHash" TEXT NOT NULL,
	"consumedAt" DATETIME,
	CONSTRAINT "ClockifyImportPreview_accountId_stageId_fkey" FOREIGN KEY ("accountId", "stageId") REFERENCES "ClockifyImportStage" ("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "ClockifyImportPreview_accountId_expiresAt_idx" ON "ClockifyImportPreview"("accountId", "expiresAt");

CREATE TABLE "ClockifyImportBatch" (
	"id" TEXT NOT NULL PRIMARY KEY,
	"accountId" TEXT NOT NULL,
	"committedAt" DATETIME NOT NULL,
	"snapshot" TEXT NOT NULL,
	CONSTRAINT "ClockifyImportBatch_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ClockifyImportBatch_accountId_id_key" ON "ClockifyImportBatch"("accountId", "id");
CREATE INDEX "ClockifyImportBatch_accountId_committedAt_idx" ON "ClockifyImportBatch"("accountId", "committedAt");

CREATE TABLE "ClockifyImportIdentity" (
	"accountId" TEXT NOT NULL,
	"fingerprint" TEXT NOT NULL,
	"occurrence" INTEGER NOT NULL DEFAULT 1 CHECK ("occurrence" >= 1),
	"candidateKey" TEXT NOT NULL,
	"entryId" TEXT NOT NULL,
	"batchId" TEXT NOT NULL,
	"entryRevision" INTEGER NOT NULL,
	"sourceSnapshot" TEXT NOT NULL,
	PRIMARY KEY ("accountId", "fingerprint", "occurrence"),
	CONSTRAINT "ClockifyImportIdentity_accountId_entryId_fkey" FOREIGN KEY ("accountId", "entryId") REFERENCES "Entry" ("accountId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
	CONSTRAINT "ClockifyImportIdentity_accountId_batchId_fkey" FOREIGN KEY ("accountId", "batchId") REFERENCES "ClockifyImportBatch" ("accountId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "ClockifyImportIdentity_accountId_candidateKey_idx" ON "ClockifyImportIdentity"("accountId", "candidateKey");
CREATE INDEX "ClockifyImportIdentity_accountId_batchId_idx" ON "ClockifyImportIdentity"("accountId", "batchId");
CREATE INDEX "ClockifyImportIdentity_accountId_entryId_idx" ON "ClockifyImportIdentity"("accountId", "entryId");
