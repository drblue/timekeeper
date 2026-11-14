CREATE TABLE "ReportSettings" (
	"accountId" TEXT NOT NULL PRIMARY KEY,
	"businessName" TEXT,
	"logoId" TEXT,
	"logoWidth" INTEGER,
	"logoHeight" INTEGER,
	"logoBytes" BLOB,
	CHECK (("logoId" IS NULL AND "logoWidth" IS NULL AND "logoHeight" IS NULL AND "logoBytes" IS NULL)
		OR ("logoId" IS NOT NULL AND "logoWidth" IS NOT NULL AND "logoHeight" IS NOT NULL AND "logoBytes" IS NOT NULL
		AND "logoWidth" BETWEEN 1 AND 1600 AND "logoHeight" BETWEEN 1 AND 1600 AND length("logoBytes") BETWEEN 1 AND 1048576)),
	CONSTRAINT "ReportSettings_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ReportSettings_logoId_key" ON "ReportSettings"("logoId");
