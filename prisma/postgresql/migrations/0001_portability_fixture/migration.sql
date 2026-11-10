-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "FixtureProject" (
    "id" VARCHAR(36) NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "FixtureProject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FixtureTimeEntry" (
    "id" VARCHAR(36) NOT NULL,
    "projectId" VARCHAR(36) NOT NULL,
    "description" TEXT NOT NULL,
    "effectiveHourlyRateOre" BIGINT,
    "billableAmountOre" BIGINT NOT NULL,
    "startedAt" TIMESTAMPTZ(0),
    "workDate" VARCHAR(10),

    CONSTRAINT "FixtureTimeEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FixtureEntryDayAllocation" (
    "entryId" VARCHAR(36) NOT NULL,
    "localDate" VARCHAR(10) NOT NULL,
    "seconds" INTEGER NOT NULL,

    CONSTRAINT "FixtureEntryDayAllocation_pkey" PRIMARY KEY ("entryId","localDate")
);

-- AddForeignKey
ALTER TABLE "FixtureTimeEntry" ADD CONSTRAINT "FixtureTimeEntry_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "FixtureProject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FixtureEntryDayAllocation" ADD CONSTRAINT "FixtureEntryDayAllocation_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "FixtureTimeEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
