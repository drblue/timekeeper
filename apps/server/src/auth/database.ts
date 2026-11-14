import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaClient } from '../generated/prisma/client.ts';

const migrationDirectory = new URL('../../../../prisma/app/migrations/', import.meta.url);
type Migration = { migration_name: string; checksum: string };

async function migrationChecksums() {
	const directory = await readdir(migrationDirectory, { withFileTypes: true });
	return Promise.all(directory.filter((entry) => entry.isDirectory()).map(async ({ name }) => ({
		migration_name: name,
		checksum: createHash('sha256').update(await readFile(new URL(`${name}/migration.sql`, migrationDirectory))).digest('hex'),
	})));
}

let expectedMigrations: ReturnType<typeof migrationChecksums> | undefined;

export async function requireCurrentDatabaseSchema(database: PrismaClient) {
	const expected = await (expectedMigrations ??= migrationChecksums());
	const history = await database.$queryRaw<(Migration & { finished_at: unknown; rolled_back_at: unknown })[]>`
		SELECT migration_name, checksum, finished_at, rolled_back_at FROM "_prisma_migrations"`;
	const current = history.filter(({ rolled_back_at }) => rolled_back_at === null);
	const exact = new Map(current.map(({ migration_name, checksum }) => [migration_name, checksum]));
	if (!expected.length || current.length !== expected.length || current.some(({ finished_at }) => finished_at === null)
		|| expected.some(({ migration_name, checksum }) => exact.get(migration_name) !== checksum)) {
		throw new Error('Database migrations do not match this Timekeeper release.');
	}
}

export function createReadinessProbe(database: PrismaClient) {
	return async () => {
		await requireCurrentDatabaseSchema(database);
		// Read a real application table as well as the migration ledger.
		await database.account.findFirst({ select: { id: true } });
	};
}

export async function openDatabase(url: string): Promise<PrismaClient> {
	const database = new PrismaClient({
		adapter: new PrismaBetterSqlite3({
			url: fileURLToPath(url),
			fileMustExist: true,
			timeout: 5_000,
		}),
		errorFormat: 'minimal',
	});

	try {
		const [mode] = await database.$queryRaw<{ journal_mode: string }[]>`PRAGMA journal_mode = WAL`;
		const [foreignKeys] = await database.$queryRaw<{ foreign_keys: number | bigint }[]>`PRAGMA foreign_keys`;
		if (mode?.journal_mode !== 'wal' || Number(foreignKeys?.foreign_keys) !== 1) {
			throw new Error('Could not enable WAL or verify foreign keys.');
		}
		await requireCurrentDatabaseSchema(database);
		await database.account.findFirst({ select: { id: true } });
		await database.session.findFirst({ select: { tokenHash: true } });
		await database.client.findFirst({ select: { id: true } });
		await database.project.findFirst({ select: { id: true } });
		await database.entry.findFirst({ select: {
			startAt: true, endAt: true, completion: true, invoicedAt: true, invoiceNumber: true, invoiceDate: true, invoiceReference: true, deletedAt: true,
			supersededAt: true, splitFromEntryId: true,
		} });
		await database.entryDayAllocation.findFirst({ select: { entryId: true } });
		await database.entryHistory.findFirst({ select: { id: true } });
		await database.runningTimer.findFirst({ select: { id: true } });
		await database.operationReceipt.findFirst({ select: { key: true } });
		await database.bulkEntryPreview.findFirst({ select: { id: true } });
		await database.reportSettings.findFirst({ select: { accountId: true } });
		await database.reportJob.findFirst({ select: { id: true } });
		await database.clockifyImportStage.findFirst({ select: { id: true } });
		await database.clockifyImportPreview.findFirst({ select: { id: true } });
		await database.clockifyImportBatch.findFirst({ select: { id: true, undoneAt: true, undoSnapshot: true } });
		await database.clockifyImportIdentity.findFirst({ select: { fingerprint: true } });
		await database.clockifyImportAlias.findFirst({ select: { fingerprint: true } });
		await database.clockifyReleasedIdentity.findFirst({ select: { entryId: true } });
		return database;
	} catch {
		await database.$disconnect();
		throw new Error('Cannot open the application database. Check its path and run npm run db:migrate.');
	}
}
