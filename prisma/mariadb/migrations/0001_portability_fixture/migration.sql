-- CreateTable
CREATE TABLE `FixtureProject` (
    `id` VARCHAR(36) NOT NULL,
    `name` VARCHAR(191) NOT NULL,

    PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin;

-- CreateTable
CREATE TABLE `FixtureTimeEntry` (
    `id` VARCHAR(36) NOT NULL,
    `projectId` VARCHAR(36) NOT NULL,
    `description` LONGTEXT NOT NULL,
    `effectiveHourlyRateOre` BIGINT NULL,
    `billableAmountOre` BIGINT NOT NULL,
    `startedAt` DATETIME(0) NULL,
    `workDate` VARCHAR(10) NULL,

    PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin;

-- CreateTable
CREATE TABLE `FixtureEntryDayAllocation` (
    `entryId` VARCHAR(36) NOT NULL,
    `localDate` VARCHAR(10) NOT NULL,
    `seconds` INTEGER NOT NULL,

    PRIMARY KEY (`entryId`, `localDate`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin;

-- AddForeignKey
ALTER TABLE `FixtureTimeEntry` ADD CONSTRAINT `FixtureTimeEntry_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `FixtureProject`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `FixtureEntryDayAllocation` ADD CONSTRAINT `FixtureEntryDayAllocation_entryId_fkey` FOREIGN KEY (`entryId`) REFERENCES `FixtureTimeEntry`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
