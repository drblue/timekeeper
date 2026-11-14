import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { entryTimeZone } from '@timekeeper/contracts';
import { allocationCalculationVersion } from '../entries/entry-record.ts';
import type { Prisma } from '../generated/prisma/client.ts';
import { exportBatchSnapshot, exportHistorySnapshot, exportSourceSnapshot, exportUndoSnapshot } from './snapshots.ts';

const applicationVersion = JSON.parse(readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8')).version as string;
const schemaVersion = '0016_clockify_undo';
const batchSize = 64;

const identityFields = {
	accountId: true, fingerprint: true, occurrence: true, candidateKey: true, entryId: true, batchId: true,
	entryRevision: true, sourceSnapshot: true,
} as const;

async function* records<T, C>(fetch: (cursor: C | undefined) => Promise<T[]>, cursorFor: (row: T) => C, pageSize = batchSize) {
	let cursor: C | undefined;
	while (true) {
		const rows = await fetch(cursor);
		for (const row of rows) yield row;
		if (rows.length < pageSize) return;
		cursor = cursorFor(rows.at(-1)!);
	}
}

function byId<T extends { id: string }>(fetch: (cursor: string | undefined) => Promise<T[]>) {
	return records(fetch, (row) => row.id);
}

const byIdPage = (cursor: string | undefined, take = batchSize) => ({
	...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
	take, orderBy: { id: 'asc' as const },
});

function identityCursor(row: { accountId: string; fingerprint: string; occurrence: number }) {
	const { accountId, fingerprint, occurrence } = row;
	return { accountId, fingerprint, occurrence };
}

type IdentityCursor = ReturnType<typeof identityCursor>;
const byIdentityPage = (cursor: IdentityCursor | undefined) => ({
	...(cursor ? { cursor: { accountId_fingerprint_occurrence: cursor }, skip: 1 } : {}),
	take: batchSize, orderBy: [{ fingerprint: 'asc' as const }, { occurrence: 'asc' as const }],
});

async function* mapRecords<T, U>(source: AsyncIterable<T>, transform: (row: T) => U) {
	for await (const row of source) yield transform(row);
}

async function* optionalRecord<T>(record: Promise<T | null>, transform: (value: T) => unknown = (value) => value) {
	const value = await record;
	if (value) yield transform(value);
}

function safeMoney(_key: string, value: unknown) {
	return typeof value === 'bigint' ? value.toString() : value;
}

export async function* portableArchive(transaction: Prisma.TransactionClient, accountId: string, exportedAt: Date) {
	const where = { accountId };
	const versions = new Set<number>();
	const sources: [string, AsyncIterable<unknown>][] = [
		['account', optionalRecord(transaction.account.findUnique({ where: { id: accountId }, select: { id: true, createdAt: true } }))],
		['clients', byId((cursor) => transaction.client.findMany({
			where, ...byIdPage(cursor),
			select: { id: true, accountId: true, name: true, notes: true, defaultRateOrePerHour: true, archivedAt: true, revision: true },
		}))],
		['projects', byId((cursor) => transaction.project.findMany({
			where, ...byIdPage(cursor),
			select: { id: true, accountId: true, clientId: true, name: true, notes: true, rateOverrideOrePerHour: true,
				defaultBillable: true, archivedAt: true, revision: true },
		}))],
		['entries', byId((cursor) => transaction.entry.findMany({
			where, ...byIdPage(cursor),
			select: { id: true, accountId: true, kind: true, description: true, localDate: true, startAt: true, endAt: true,
				durationSeconds: true, projectId: true, directClientId: true, billable: true, assignedRateOrePerHour: true,
				billableAmountOre: true, completion: true, invoicedAt: true, invoiceNumber: true, invoiceDate: true,
				invoiceReference: true, deletedAt: true, supersededAt: true, splitFromEntryId: true, revision: true, createdAt: true },
		}))],
		['entryDayAllocations', mapRecords(records(
			(cursor: { entryId: string; localDate: string } | undefined) => transaction.entryDayAllocation.findMany({
				where: { entry: where },
				...(cursor ? { cursor: { entryId_localDate: cursor }, skip: 1 } : {}),
				take: batchSize, orderBy: [{ entryId: 'asc' }, { localDate: 'asc' }],
				select: { entryId: true, localDate: true, seconds: true, amountOre: true, calculationVersion: true },
			}), ({ entryId, localDate }) => ({ entryId, localDate }),
		), (row) => { versions.add(row.calculationVersion); return row; })],
		['entryHistory', mapRecords(byId((cursor) => transaction.entryHistory.findMany({
			where: { entry: where }, ...byIdPage(cursor),
			select: { id: true, entryId: true, action: true, at: true, beforeSnapshot: true, afterSnapshot: true },
		})), ({ beforeSnapshot, afterSnapshot, ...row }) => ({
			...row, beforeSnapshot: exportHistorySnapshot(beforeSnapshot), afterSnapshot: exportHistorySnapshot(afterSnapshot),
		}))],
		['runningTimer', optionalRecord(transaction.runningTimer.findUnique({
			where, select: { id: true, accountId: true, startAt: true, description: true, projectId: true, directClientId: true,
				billable: true, assignedRateOrePerHour: true, revision: true },
		}))],
		['reportSettings', optionalRecord(transaction.reportSettings.findUnique({
			where, select: { accountId: true, businessName: true, logoId: true, logoWidth: true, logoHeight: true, logoBytes: true },
		}), ({ logoBytes, ...row }) => ({ ...row, logoPngBase64: logoBytes === null ? null : Buffer.from(logoBytes).toString('base64') }))],
		['clockifyImportBatches', mapRecords(records((cursor: string | undefined) => transaction.clockifyImportBatch.findMany({
			where, ...byIdPage(cursor, 1), select: { id: true, accountId: true, committedAt: true, undoneAt: true, snapshot: true, undoSnapshot: true },
		}), ({ id }) => id, 1), ({ snapshot, undoSnapshot, ...row }) => ({ ...row, snapshot: exportBatchSnapshot(snapshot), undoSnapshot: exportUndoSnapshot(undoSnapshot) }))],
		['clockifyImportIdentities', mapRecords(records((cursor: IdentityCursor | undefined) => transaction.clockifyImportIdentity.findMany({
			where, ...byIdentityPage(cursor), select: identityFields,
		}), identityCursor), ({ sourceSnapshot, ...row }) => ({ ...row, sourceSnapshot: exportSourceSnapshot(sourceSnapshot) }))],
		['clockifyImportAliases', mapRecords(records((cursor: IdentityCursor | undefined) => transaction.clockifyImportAlias.findMany({
			where, ...byIdentityPage(cursor),
			select: { accountId: true, fingerprint: true, occurrence: true, candidateKey: true, targetFingerprint: true,
				targetOccurrence: true, batchId: true, resolution: true, sourceSnapshot: true },
		}), identityCursor), ({ sourceSnapshot, ...row }) => ({ ...row, sourceSnapshot: exportSourceSnapshot(sourceSnapshot) }))],
		['clockifyReleasedIdentities', mapRecords(records((cursor: { accountId: string; entryId: string } | undefined) =>
			transaction.clockifyReleasedIdentity.findMany({
				where, ...(cursor ? { cursor: { accountId_entryId: cursor }, skip: 1 } : {}),
				take: batchSize, orderBy: { entryId: 'asc' }, select: identityFields,
			}), ({ accountId, entryId }) => ({ accountId, entryId })),
		({ sourceSnapshot, ...row }) => ({ ...row, sourceSnapshot: exportSourceSnapshot(sourceSnapshot) }))],
	];

	const sections: Record<string, { records: number; sha256: string }> = {};
	for (const [section, source] of sources) {
		const hash = createHash('sha256');
		let count = 0;
		for await (const data of source) {
			const line = JSON.stringify({ section, data }, safeMoney) + '\n';
			hash.update(line, 'utf8');
			count += 1;
			yield line;
		}
		sections[section] = { records: count, sha256: hash.digest('hex') };
	}
	yield JSON.stringify({ section: 'manifest', data: {
		format: 'timekeeper-portable', formatVersion: 1, schemaVersion, applicationVersion, exportedAt: exportedAt.toISOString(),
		timezone: entryTimeZone, currency: 'SEK', calculationVersion: allocationCalculationVersion,
		calculationVersions: [...versions].sort((left, right) => left - right), algorithm: 'sha256', sections,
	} }) + '\n';
}
