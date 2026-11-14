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
	"invoicedAt" DATETIME,
	"invoiceNumber" TEXT,
	"invoiceDate" TEXT,
	"invoiceReference" TEXT,
	"deletedAt" DATETIME,
	"supersededAt" DATETIME,
	"splitFromEntryId" TEXT,
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
	CHECK ("supersededAt" IS NULL OR ("deletedAt" IS NULL AND "invoicedAt" IS NULL AND "kind" = 'timed' AND "completion" = 'complete')),
	CHECK ("splitFromEntryId" IS NULL OR "splitFromEntryId" <> "id"),
	CONSTRAINT "Entry_accountId_splitFromEntryId_fkey" FOREIGN KEY ("accountId", "splitFromEntryId") REFERENCES "new_Entry" ("accountId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
	CONSTRAINT "Entry_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
	CONSTRAINT "Entry_accountId_projectId_fkey" FOREIGN KEY ("accountId", "projectId") REFERENCES "Project" ("accountId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
	CONSTRAINT "Entry_accountId_directClientId_fkey" FOREIGN KEY ("accountId", "directClientId") REFERENCES "Client" ("accountId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "Entry_accountId_id_key" ON "new_Entry"("accountId", "id");

CREATE TABLE "new_EntryDayAllocation" (
	"entryId" TEXT NOT NULL,
	"localDate" TEXT NOT NULL,
	"seconds" INTEGER NOT NULL CHECK ("seconds" BETWEEN 1 AND 2147483647),
	"amountOre" BIGINT NOT NULL CHECK ("amountOre" >= 0),
	"calculationVersion" INTEGER NOT NULL CHECK ("calculationVersion" >= 1),
	PRIMARY KEY ("entryId", "localDate"),
	CONSTRAINT "EntryDayAllocation_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "new_Entry" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "new_EntryHistory" (
	"id" TEXT NOT NULL PRIMARY KEY,
	"entryId" TEXT NOT NULL,
	"action" TEXT NOT NULL,
	"at" DATETIME NOT NULL,
	"beforeSnapshot" TEXT,
	"afterSnapshot" TEXT NOT NULL,
	"operationKey" TEXT,
	CONSTRAINT "EntryHistory_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "new_Entry" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

INSERT INTO "new_Entry" ("id", "accountId", "kind", "description", "localDate", "startAt", "endAt", "durationSeconds", "projectId", "directClientId",
	"billable", "assignedRateOrePerHour", "billableAmountOre", "completion", "revision", "createdAt", "invoicedAt",
	"invoiceNumber", "invoiceDate", "invoiceReference", "deletedAt")
SELECT "id", "accountId", "kind", "description", "localDate", "startAt", "endAt", "durationSeconds", "projectId", "directClientId",
	"billable", "assignedRateOrePerHour", "billableAmountOre", "completion", "revision", "createdAt", "invoicedAt",
	"invoiceNumber", "invoiceDate", "invoiceReference", "deletedAt" FROM "Entry";

INSERT INTO "new_EntryDayAllocation" ("entryId", "localDate", "seconds", "amountOre", "calculationVersion")
SELECT "entryId", "localDate", "seconds", "amountOre", "calculationVersion" FROM "EntryDayAllocation";

INSERT INTO "new_EntryHistory" ("id", "entryId", "action", "at", "beforeSnapshot", "afterSnapshot", "operationKey")
SELECT "id", "entryId", "action", "at", "beforeSnapshot", "afterSnapshot", "operationKey" FROM "EntryHistory";

DROP TABLE "EntryHistory";
DROP TABLE "EntryDayAllocation";
DROP TABLE "Entry";
ALTER TABLE "new_Entry" RENAME TO "Entry";
ALTER TABLE "new_EntryDayAllocation" RENAME TO "EntryDayAllocation";

CREATE INDEX "Entry_accountId_localDate_createdAt_idx" ON "Entry"("accountId", "localDate", "createdAt");
CREATE INDEX "Entry_accountId_projectId_idx" ON "Entry"("accountId", "projectId");
CREATE INDEX "Entry_accountId_directClientId_idx" ON "Entry"("accountId", "directClientId");
CREATE INDEX "Entry_accountId_startAt_endAt_idx" ON "Entry"("accountId", "startAt", "endAt");

ALTER TABLE "new_EntryHistory" RENAME TO "EntryHistory";
CREATE INDEX "EntryHistory_entryId_at_idx" ON "EntryHistory"("entryId", "at");
CREATE INDEX "Entry_accountId_invoicedAt_idx" ON "Entry"("accountId", "invoicedAt");
CREATE INDEX "Entry_accountId_deletedAt_idx" ON "Entry"("accountId", "deletedAt");
CREATE INDEX "Entry_accountId_splitFromEntryId_idx" ON "Entry"("accountId", "splitFromEntryId");
CREATE INDEX "EntryDayAllocation_localDate_entryId_idx" ON "EntryDayAllocation"("localDate", "entryId");

COMMIT;
