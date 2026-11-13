BEGIN;

CREATE TABLE "new_Entry" (
	"id" TEXT NOT NULL PRIMARY KEY,
	"accountId" TEXT NOT NULL,
	"kind" TEXT NOT NULL,
	"description" TEXT NOT NULL,
	"localDate" TEXT NOT NULL,
	"startAt" DATETIME,
	"endAt" DATETIME,
	"durationSeconds" INTEGER NOT NULL CHECK ("durationSeconds" BETWEEN 0 AND 2147483647),
	"projectId" TEXT,
	"directClientId" TEXT,
	"billable" BOOLEAN NOT NULL CHECK ("billable" IN (0, 1)),
	"assignedRateOrePerHour" BIGINT CHECK ("assignedRateOrePerHour" >= 0),
	"billableAmountOre" BIGINT CHECK ("billableAmountOre" >= 0),
	"completion" TEXT NOT NULL DEFAULT 'complete',
	"revision" INTEGER NOT NULL DEFAULT 1 CHECK ("revision" >= 1),
	"createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CHECK (("kind" = 'duration-only' AND "startAt" IS NULL AND "endAt" IS NULL) OR
		("kind" = 'timed' AND "startAt" IS NOT NULL AND "endAt" IS NOT NULL AND "startAt" <= "endAt")),
	CHECK ("projectId" IS NULL OR "directClientId" IS NULL),
	CHECK (("completion" = 'complete' AND length(trim("description")) > 0 AND "durationSeconds" > 0
		AND "billableAmountOre" IS NOT NULL
		AND ("billable" = 0 OR "assignedRateOrePerHour" IS NOT NULL)
		AND ("billable" = 1 OR "billableAmountOre" = 0))
		OR ("completion" = 'incomplete' AND "kind" = 'timed' AND "billableAmountOre" IS NULL)),
	CHECK ("kind" <> 'timed' OR ("startAt" = "endAt") = ("durationSeconds" = 0)),
	CONSTRAINT "Entry_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
	CONSTRAINT "Entry_accountId_projectId_fkey" FOREIGN KEY ("accountId", "projectId") REFERENCES "Project" ("accountId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
	CONSTRAINT "Entry_accountId_directClientId_fkey" FOREIGN KEY ("accountId", "directClientId") REFERENCES "Client" ("accountId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "new_EntryDayAllocation" (
	"entryId" TEXT NOT NULL,
	"localDate" TEXT NOT NULL,
	"seconds" INTEGER NOT NULL CHECK ("seconds" BETWEEN 1 AND 2147483647),
	"amountOre" BIGINT NOT NULL CHECK ("amountOre" >= 0),
	"calculationVersion" INTEGER NOT NULL CHECK ("calculationVersion" >= 1),
	PRIMARY KEY ("entryId", "localDate"),
	CONSTRAINT "EntryDayAllocation_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "new_Entry" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

INSERT INTO "new_Entry" ("id", "accountId", "kind", "description", "localDate", "startAt", "endAt", "durationSeconds", "projectId", "directClientId",
	"billable", "assignedRateOrePerHour", "billableAmountOre", "revision", "createdAt")
SELECT "id", "accountId", "kind", "description", "localDate", "startAt", "endAt", "durationSeconds", "projectId", "directClientId",
	"billable", "assignedRateOrePerHour", "billableAmountOre", "revision", "createdAt" FROM "Entry";

INSERT INTO "new_EntryDayAllocation" ("entryId", "localDate", "seconds", "amountOre", "calculationVersion")
SELECT "entryId", "localDate", "seconds", "amountOre", "calculationVersion" FROM "EntryDayAllocation";

DROP TABLE "EntryDayAllocation";
DROP TABLE "Entry";
ALTER TABLE "new_Entry" RENAME TO "Entry";
ALTER TABLE "new_EntryDayAllocation" RENAME TO "EntryDayAllocation";

CREATE INDEX "Entry_accountId_localDate_createdAt_idx" ON "Entry"("accountId", "localDate", "createdAt");
CREATE INDEX "Entry_accountId_projectId_idx" ON "Entry"("accountId", "projectId");
CREATE INDEX "Entry_accountId_directClientId_idx" ON "Entry"("accountId", "directClientId");
CREATE INDEX "Entry_accountId_startAt_endAt_idx" ON "Entry"("accountId", "startAt", "endAt");

CREATE TABLE "RunningTimer" (
	"accountId" TEXT NOT NULL PRIMARY KEY,
	"id" TEXT NOT NULL,
	"startAt" DATETIME NOT NULL,
	"description" TEXT NOT NULL,
	"projectId" TEXT,
	"directClientId" TEXT,
	"billable" BOOLEAN NOT NULL CHECK ("billable" IN (0, 1)),
	"assignedRateOrePerHour" BIGINT CHECK ("assignedRateOrePerHour" >= 0),
	"revision" INTEGER NOT NULL DEFAULT 1 CHECK ("revision" >= 1),
	CHECK ("projectId" IS NULL OR "directClientId" IS NULL),
	CONSTRAINT "RunningTimer_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
	CONSTRAINT "RunningTimer_accountId_projectId_fkey" FOREIGN KEY ("accountId", "projectId") REFERENCES "Project" ("accountId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
	CONSTRAINT "RunningTimer_accountId_directClientId_fkey" FOREIGN KEY ("accountId", "directClientId") REFERENCES "Client" ("accountId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "RunningTimer_id_key" ON "RunningTimer"("id");

CREATE TABLE "OperationReceipt" (
	"accountId" TEXT NOT NULL,
	"key" TEXT NOT NULL,
	"requestHash" TEXT NOT NULL,
	"resultSnapshot" TEXT NOT NULL,
	"completedAt" DATETIME NOT NULL,
	PRIMARY KEY ("accountId", "key"),
	CONSTRAINT "OperationReceipt_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "EntryHistory" (
	"id" TEXT NOT NULL PRIMARY KEY,
	"entryId" TEXT NOT NULL,
	"action" TEXT NOT NULL,
	"at" DATETIME NOT NULL,
	"beforeSnapshot" TEXT,
	"afterSnapshot" TEXT NOT NULL,
	"operationKey" TEXT,
	CONSTRAINT "EntryHistory_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "Entry" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "EntryHistory_entryId_at_idx" ON "EntryHistory"("entryId", "at");

COMMIT;
