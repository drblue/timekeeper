CREATE TABLE "Client" (
	"id" TEXT NOT NULL PRIMARY KEY,
	"accountId" TEXT NOT NULL,
	"name" TEXT NOT NULL,
	"notes" TEXT,
	"defaultRateOrePerHour" BIGINT CHECK ("defaultRateOrePerHour" >= 0),
	"archivedAt" DATETIME,
	"revision" INTEGER NOT NULL DEFAULT 1 CHECK ("revision" >= 1),
	CONSTRAINT "Client_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "Client_accountId_id_key" ON "Client"("accountId", "id");
CREATE INDEX "Client_accountId_archivedAt_idx" ON "Client"("accountId", "archivedAt");

CREATE TABLE "Project" (
	"id" TEXT NOT NULL PRIMARY KEY,
	"accountId" TEXT NOT NULL,
	"clientId" TEXT,
	"name" TEXT NOT NULL,
	"notes" TEXT,
	"rateOverrideOrePerHour" BIGINT CHECK ("rateOverrideOrePerHour" >= 0),
	"defaultBillable" BOOLEAN NOT NULL DEFAULT true,
	"archivedAt" DATETIME,
	"revision" INTEGER NOT NULL DEFAULT 1 CHECK ("revision" >= 1),
	CONSTRAINT "Project_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
	CONSTRAINT "Project_accountId_clientId_fkey" FOREIGN KEY ("accountId", "clientId") REFERENCES "Client" ("accountId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "Project_accountId_archivedAt_idx" ON "Project"("accountId", "archivedAt");
CREATE INDEX "Project_accountId_clientId_idx" ON "Project"("accountId", "clientId");
