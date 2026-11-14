import { createHash } from 'node:crypto';
// @ts-expect-error The pinned native driver does not publish TypeScript declarations.
import Database from 'better-sqlite3';
import { allocationCalculationVersion } from '../entries/entry-record.ts';
import { verifyMigrationHistory } from '../auth/database.ts';

interface Statement {
	all(): unknown[];
	get(): unknown;
}

interface SQLite {
	backup(destination: string, options?: { progress: () => number }): Promise<unknown>;
	pragma(expression: string): unknown;
	prepare(query: string): Statement;
	defaultSafeIntegers(): void;
	exec(query: string): void;
	close(): void;
}

function connect(path: string, readonly: boolean): SQLite {
	return new Database(path, { readonly, fileMustExist: true, timeout: 5_000 }) as SQLite;
}

export async function snapshotSqlite(source: string, destination: string, signal?: AbortSignal) {
	const database = connect(source, true);
	try {
		signal?.throwIfAborted();
		await database.backup(destination, { progress: () => {
			signal?.throwIfAborted();
			return 100;
		} });
		signal?.throwIfAborted();
	} finally {
		database.close();
	}
	const snapshot = connect(destination, false);
	try {
		const mode = snapshot.pragma('journal_mode = DELETE') as { journal_mode: string }[];
		if (mode[0]?.journal_mode !== 'delete') throw new Error('Snapshot could not be made self-contained');
	} finally {
		snapshot.close();
	}
}

const tables = [
	'Account', 'Session', 'ReportSettings', 'ReportJob', 'Client', 'Project', 'Entry', 'EntryDayAllocation',
	'RunningTimer', 'OperationReceipt', 'BulkEntryPreview', 'EntryHistory', 'ClockifyImportStage',
	'ClockifyImportPreview', 'ClockifyImportBatch', 'ClockifyImportIdentity', 'ClockifyImportAlias', 'ClockifyReleasedIdentity',
] as const;

export async function inspectSqlite(path: string) {
	const database = connect(path, true);
	try {
		const integrity = database.pragma('integrity_check') as { integrity_check: string }[];
		if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok'
			|| (database.pragma('foreign_key_check') as unknown[]).length) {
			throw new Error('SQLite integrity or foreign-key check failed');
		}
		const schema = await verifyMigrationHistory(database.prepare(
			'SELECT migration_name, checksum, finished_at, rolled_back_at FROM "_prisma_migrations"',
		).all() as Parameters<typeof verifyMigrationHistory>[0]);
		database.defaultSafeIntegers();
		const counts = Object.fromEntries(tables.map((table) => [
			table, (database.prepare(`SELECT COUNT(*) AS "count" FROM "${table}"`).get() as { count: bigint }).count.toString(),
		]));
		const totals = { seconds: 0n, amountOre: 0n };
		// SQLite SUM on 64-bit integer amounts can overflow. Accumulate per row as bigint.
		const allocations = database.prepare('SELECT "seconds", "amountOre", "calculationVersion" FROM "EntryDayAllocation"') as Statement & {
			iterate(): Iterable<{ seconds: bigint; amountOre: bigint; calculationVersion: bigint }>;
		};
		const versions = new Set<number>();
		for (const row of allocations.iterate()) {
			totals.seconds += row.seconds;
			totals.amountOre += row.amountOre;
			versions.add(Number(row.calculationVersion));
		}
		const logos = database.prepare('SELECT "logoId", "logoBytes" FROM "ReportSettings" WHERE "logoId" IS NOT NULL ORDER BY "logoId"').all() as { logoId: string; logoBytes: Buffer }[];
		const persistentAssets = logos.map(({ logoId, logoBytes }) => ({
			kind: 'report-logo-png', id: logoId, bytes: logoBytes.length,
			sha256: createHash('sha256').update(logoBytes).digest('hex'),
		}));
		return { schemaVersion: schema.at(-1)!.migration_name, migrations: schema, counts, persistentAssets,
			calculationVersion: allocationCalculationVersion, calculationVersions: [...versions].sort((a, b) => a - b),
			allocationTotals: { seconds: totals.seconds.toString(), amountOre: totals.amountOre.toString() } };
	} finally {
		database.close();
	}
}

export function clearTransientRestoreData(path: string) {
	const database = connect(path, false);
	try {
		database.pragma('foreign_keys = ON');
		database.pragma('secure_delete = ON');
		database.exec(`BEGIN;
			DELETE FROM "Session";
			DELETE FROM "ReportJob";
			DELETE FROM "BulkEntryPreview";
			DELETE FROM "ClockifyImportStage";
			COMMIT;`);
	} finally {
		database.close();
	}
}
