BEGIN;

CREATE TABLE "new_Entry" (
	"id" TEXT NOT NULL PRIMARY KEY,
	"accountId" TEXT NOT NULL,
	"kind" TEXT NOT NULL,
	"description" TEXT NOT NULL,
	"localDate" TEXT NOT NULL,
	"startAt" DATETIME,
	"endAt" DATETIME,
	"durationSeconds" INTEGER NOT NULL CHECK ("durationSeconds" BETWEEN 1 AND 2147483647),
	"projectId" TEXT,
	"directClientId" TEXT,
	"billable" BOOLEAN NOT NULL CHECK ("billable" IN (0, 1)),
	"assignedRateOrePerHour" BIGINT CHECK ("assignedRateOrePerHour" >= 0),
	"billableAmountOre" BIGINT NOT NULL CHECK ("billableAmountOre" >= 0),
	"revision" INTEGER NOT NULL DEFAULT 1 CHECK ("revision" >= 1),
	"createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CHECK (("kind" = 'duration-only' AND "startAt" IS NULL AND "endAt" IS NULL) OR
		("kind" = 'timed' AND "startAt" IS NOT NULL AND "endAt" IS NOT NULL AND "startAt" < "endAt")),
	CHECK ("projectId" IS NULL OR "directClientId" IS NULL),
	CHECK ("billable" = 0 OR "assignedRateOrePerHour" IS NOT NULL),
	CHECK ("billable" = 1 OR "billableAmountOre" = 0),
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

INSERT INTO "new_Entry" ("id", "accountId", "kind", "description", "localDate", "durationSeconds", "projectId", "directClientId",
	"billable", "assignedRateOrePerHour", "billableAmountOre", "revision", "createdAt")
SELECT "id", "accountId", "kind", "description", "localDate", "durationSeconds", "projectId", "directClientId",
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

COMMIT;
