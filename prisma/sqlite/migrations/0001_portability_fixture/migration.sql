-- CreateTable
CREATE TABLE "FixtureProject" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "FixtureTimeEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "effectiveHourlyRateOre" BIGINT,
    "billableAmountOre" BIGINT NOT NULL,
    "startedAt" DATETIME,
    "workDate" TEXT,
    CONSTRAINT "FixtureTimeEntry_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "FixtureProject" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "FixtureEntryDayAllocation" (
    "entryId" TEXT NOT NULL,
    "localDate" TEXT NOT NULL,
    "seconds" INTEGER NOT NULL,

    PRIMARY KEY ("entryId", "localDate"),
    CONSTRAINT "FixtureEntryDayAllocation_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "FixtureTimeEntry" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
