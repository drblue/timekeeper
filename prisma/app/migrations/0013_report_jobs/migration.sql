CREATE TABLE "ReportJob" (
	"id" TEXT NOT NULL PRIMARY KEY,
	"accountId" TEXT NOT NULL,
	"status" TEXT NOT NULL CHECK ("status" IN ('queued', 'running', 'ready', 'failed', 'expired')),
	"createdAt" DATETIME NOT NULL,
	"expiresAt" DATETIME,
	"input" TEXT,
	"errorCode" TEXT,
	CONSTRAINT "ReportJob_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "ReportJob_status_createdAt_idx" ON "ReportJob"("status", "createdAt");
CREATE INDEX "ReportJob_expiresAt_idx" ON "ReportJob"("expiresAt");
