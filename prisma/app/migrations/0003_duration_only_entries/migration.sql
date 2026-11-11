CREATE UNIQUE INDEX "Project_accountId_id_key" ON "Project"("accountId", "id");

CREATE TABLE "Entry" (
	"id" TEXT NOT NULL PRIMARY KEY,
	"accountId" TEXT NOT NULL,
	"kind" TEXT NOT NULL CHECK ("kind" = 'duration-only'),
	"description" TEXT NOT NULL,
	"localDate" TEXT NOT NULL,
	"durationSeconds" INTEGER NOT NULL CHECK ("durationSeconds" BETWEEN 1 AND 2147483647),
	"projectId" TEXT,
	"directClientId" TEXT,
	"billable" BOOLEAN NOT NULL CHECK ("billable" IN (0, 1)),
	"assignedRateOrePerHour" BIGINT CHECK ("assignedRateOrePerHour" >= 0),
	"billableAmountOre" BIGINT NOT NULL CHECK ("billableAmountOre" >= 0),
	"revision" INTEGER NOT NULL DEFAULT 1 CHECK ("revision" >= 1),
	"createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CHECK ("projectId" IS NULL OR "directClientId" IS NULL),
	CHECK ("billable" = 0 OR "assignedRateOrePerHour" IS NOT NULL),
	CHECK ("billable" = 1 OR "billableAmountOre" = 0),
	CONSTRAINT "Entry_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
	CONSTRAINT "Entry_accountId_projectId_fkey" FOREIGN KEY ("accountId", "projectId") REFERENCES "Project" ("accountId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
	CONSTRAINT "Entry_accountId_directClientId_fkey" FOREIGN KEY ("accountId", "directClientId") REFERENCES "Client" ("accountId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "Entry_accountId_localDate_createdAt_idx" ON "Entry"("accountId", "localDate", "createdAt");
CREATE INDEX "Entry_accountId_projectId_idx" ON "Entry"("accountId", "projectId");
CREATE INDEX "Entry_accountId_directClientId_idx" ON "Entry"("accountId", "directClientId");

CREATE TABLE "EntryDayAllocation" (
	"entryId" TEXT NOT NULL,
	"localDate" TEXT NOT NULL,
	"seconds" INTEGER NOT NULL CHECK ("seconds" BETWEEN 1 AND 2147483647),
	"amountOre" BIGINT NOT NULL CHECK ("amountOre" >= 0),
	"calculationVersion" INTEGER NOT NULL CHECK ("calculationVersion" >= 1),
	PRIMARY KEY ("entryId", "localDate"),
	CONSTRAINT "EntryDayAllocation_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "Entry" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
