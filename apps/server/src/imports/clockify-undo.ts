import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { EntryResponse, parseClockifyUndoCommitResponse } from '@timekeeper/contracts';
import type { ClockifyImportBatchListQuery, ClockifyImportBatchSummary, ClockifyUndoEntry, ClockifyUndoIssue } from '@timekeeper/contracts';
import { ApiRequestError } from '../api-error.ts';
import { trashImportedEntry } from '../entries/entry-deletion.ts';
import { entryRelations, entryResponse } from '../entries/entry-record.ts';
import { recordHistory } from '../entries/entry-history.ts';
import type { Prisma, PrismaClient } from '../generated/prisma/client.ts';
import { writeWithReceipt } from '../operation-receipt.ts';
import { clockifyHash } from './clockify-identity.ts';

const maxUndoPageSize = 20;
const undoTimeoutMs = 30_000;
const Batch = Type.Object({
	version: Type.Literal(1),
	sourceTimeZone: Type.String(),
	review: Type.Object({ counts: Type.Object({
		new: Type.Integer(), alreadyImported: Type.Integer(), excluded: Type.Integer(),
		incomplete: Type.Integer(), invoiced: Type.Integer(),
		duplicateOmitted: Type.Optional(Type.Integer()),
		keptExisting: Type.Optional(Type.Integer()), updatedExisting: Type.Optional(Type.Integer()),
	}) }),
});
const SavedAllocation = Type.Object({
	localDate: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
	seconds: Type.Integer({ minimum: 1 }),
	amountOre: Type.String({ pattern: '^(0|[1-9][0-9]{0,18})$' }),
	calculationVersion: Type.Integer({ minimum: 1 }),
}, { additionalProperties: false });
const SavedWork = Type.Object({ entry: EntryResponse, allocations: Type.Array(SavedAllocation) }, { additionalProperties: false });
const CorrectionUpdate = Type.Object({ entryId: Type.String(), before: SavedWork, after: SavedWork }, { additionalProperties: false });
const CorrectionUpdates = Type.Array(CorrectionUpdate, { maxItems: 100 });
type SavedWork = Static<typeof SavedWork>;
type CorrectionUpdate = Static<typeof CorrectionUpdate>;

const batchDates = { id: true, committedAt: true, undoneAt: true } as const;
const batchSelect = { ...batchDates, snapshot: true } as const;
type BatchRecord = Prisma.ClockifyImportBatchGetPayload<{ select: typeof batchSelect }>;
const currentFields = {
	id: true, revision: true, description: true, localDate: true, startAt: true, endAt: true, durationSeconds: true, billableAmountOre: true,
	invoicedAt: true, invoiceNumber: true, invoiceDate: true, invoiceReference: true, deletedAt: true,
	supersededAt: true, splitFromEntryId: true,
} as const;
type Current = Prisma.EntryGetPayload<{ select: typeof currentFields }>;

function batchNotFound(): never {
	throw new ApiRequestError(404, 'CLOCKIFY_BATCH_NOT_FOUND', 'This Clockify import batch was not found.');
}

function undoChanged(): never {
	throw new ApiRequestError(409, 'CLOCKIFY_UNDO_CHANGED', 'The import or its time entries changed. Review the undo again.');
}

function readBatch(row: BatchRecord) {
	const parsed: unknown = JSON.parse(row.snapshot);
	if (!Value.Check(Batch, parsed)) throw new Error('Invalid Clockify batch snapshot');
	const counts = parsed.review.counts;
	const summary: ClockifyImportBatchSummary = {
		id: row.id, committedAt: row.committedAt.toISOString(), undoneAt: row.undoneAt?.toISOString() ?? null,
		sourceTimeZone: parsed.sourceTimeZone,
		createdCount: counts.new, updatedExistingCount: counts.updatedExisting ?? 0, keptExistingCount: counts.keptExisting ?? 0,
		alreadyImportedCount: counts.alreadyImported, excludedCount: counts.excluded, incompleteCount: counts.incomplete,
		invoicedCount: counts.invoiced, duplicateOmittedCount: counts.duplicateOmitted ?? 0,
	};
	const updates = 'correctionUpdates' in parsed ? parsed.correctionUpdates : [];
	return { summary, updates };
}

function undoEntry(current: Current, action: ClockifyUndoEntry['action'], issues: ClockifyUndoIssue[], restore?: SavedWork) {
	const old = restore?.entry;
	return {
		id: current.id, action, description: current.description, localDate: current.localDate, durationSeconds: current.durationSeconds,
		startAt: current.startAt?.toISOString() ?? null, endAt: current.endAt?.toISOString() ?? null,
		amountOre: current.billableAmountOre?.toString() ?? null, invoicedAt: current.invoicedAt?.toISOString() ?? null,
		restore: old ? {
			description: old.description, localDate: old.localDate, durationSeconds: old.durationSeconds, amountOre: old.billableAmountOre,
			startAt: old.kind === 'timed' ? old.startAt : null, endAt: old.kind === 'timed' ? old.endAt : null,
		} : null,
		issues,
	} satisfies ClockifyUndoEntry;
}

function lifecycleIssues(entry: Current, revision: number, initialInvoice: Date | null) {
	const issues: ClockifyUndoIssue[] = [];
	if (entry.revision !== revision) issues.push('entry-changed');
	if (entry.deletedAt) issues.push('entry-deleted');
	if (entry.supersededAt || entry.splitFromEntryId) issues.push('entry-split');
	if (entry.invoicedAt && (entry.invoicedAt.getTime() !== initialInvoice?.getTime()
		|| entry.invoiceNumber !== null || entry.invoiceDate !== null || entry.invoiceReference !== null)) issues.push('entry-invoiced-later');
	return issues;
}

async function batchEntry(transaction: Prisma.TransactionClient, accountId: string, id: string) {
	const batch = await transaction.clockifyImportBatch.findUnique({ where: { id, accountId }, select: batchSelect });
	if (!batch) batchNotFound();
	return batch;
}

async function planUndo(transaction: Prisma.TransactionClient, accountId: string, id: string) {
	const batch = await batchEntry(transaction, accountId, id);
	const { summary, updates: savedUpdates } = readBatch(batch);
	const entries: ClockifyUndoEntry[] = [];
	const issues = new Set<ClockifyUndoIssue>();
	if (batch.undoneAt) {
		issues.add('already-undone');
		return { batch: summary, entries, issues: [...issues], canUndo: false, previewHash: null,
			trashCount: 0, revertCount: 0, releaseIdentityCount: 0, releaseAliasCount: 0 };
	}

	const roots = await transaction.clockifyImportIdentity.findMany({
		where: { accountId, batchId: id },
		select: { fingerprint: true, occurrence: true, entryId: true, entryRevision: true },
		orderBy: [{ fingerprint: 'asc' }, { occurrence: 'asc' }],
	});
	const currentRoots = new Map<string, Current>();
	for (let start = 0; start < roots.length; start += 256) {
		const entries = await transaction.entry.findMany({
			where: { accountId, id: { in: roots.slice(start, start + 256).map(({ entryId }) => entryId) } }, select: currentFields,
		});
		for (const entry of entries) currentRoots.set(entry.id, entry);
	}
	const aliases = await transaction.clockifyImportAlias.findMany({
		where: { accountId, batchId: id },
		select: { fingerprint: true, occurrence: true, resolution: true, targetFingerprint: true, targetOccurrence: true,
			target: { select: { entryId: true, entry: { select: currentFields } } } },
		orderBy: [{ fingerprint: 'asc' }, { occurrence: 'asc' }],
	});
	const dependentRoots = await transaction.clockifyImportIdentity.findMany({
		where: { accountId, batchId: id, aliases: { some: { accountId, batchId: { not: id } } } },
		select: { fingerprint: true, occurrence: true },
	});
	const dependentRootKeys = new Set(dependentRoots.map(({ fingerprint, occurrence }) => JSON.stringify([fingerprint, occurrence])));

	const updates = new Map<string, CorrectionUpdate>();
	if (!Value.Check(CorrectionUpdates, savedUpdates)) issues.add('history-unavailable');
	else {
		for (const update of savedUpdates) {
			if (update.entryId !== update.before.entry.id || update.entryId !== update.after.entry.id || updates.has(update.entryId)
				|| update.before.entry.completion !== 'complete' || update.after.entry.completion !== 'complete'
				|| update.before.entry.revision + 1 !== update.after.entry.revision) issues.add('history-unavailable');
			else updates.set(update.entryId, update);
		}
	}
	if (roots.length !== summary.createdCount || updates.size !== summary.updatedExistingCount
		|| aliases.length !== summary.keptExistingCount + summary.updatedExistingCount
		|| aliases.filter(({ resolution }) => resolution === 'update').length !== updates.size) issues.add('history-unavailable');

	const affected = new Set<string>();
	const digestedEntries: unknown[] = [];
	for (const root of roots) {
		const current = currentRoots.get(root.entryId);
		if (!current) {
			issues.add('history-unavailable');
			continue;
		}
		const rowIssues = lifecycleIssues(current, root.entryRevision, batch.committedAt);
		if (dependentRootKeys.has(JSON.stringify([root.fingerprint, root.occurrence]))) rowIssues.push('dependent-correction');
		if (affected.has(root.entryId)) rowIssues.push('history-unavailable');
		affected.add(root.entryId);
		entries.push(undoEntry(current, 'trash', rowIssues));
		digestedEntries.push([root.fingerprint, root.occurrence, root.entryId, current.revision]);
		for (const issue of rowIssues) issues.add(issue);
	}

	for (const alias of aliases) {
		const { entry, entryId } = alias.target;
		if (alias.resolution === 'keep') continue;
		const update = updates.get(entryId);
		if (alias.resolution !== 'update' || !update) {
			issues.add('history-unavailable');
			continue;
		}
		const rowIssues = lifecycleIssues(entry, update.after.entry.revision, null);
		if (affected.has(entryId)) rowIssues.push('history-unavailable');
		affected.add(entryId);
		const dependentAlias = await transaction.clockifyImportAlias.findFirst({
			where: {
				accountId, targetFingerprint: alias.targetFingerprint, targetOccurrence: alias.targetOccurrence, batchId: { not: id },
				// Equal millisecond commits have no trustworthy order. Block conservatively.
				batch: { committedAt: { gte: batch.committedAt } },
			},
			select: { batchId: true },
		});
		if (dependentAlias) rowIssues.push('dependent-correction');
		entries.push(undoEntry(entry, 'revert', rowIssues, update.before));
		digestedEntries.push([alias.targetFingerprint, alias.targetOccurrence, entryId, entry.revision, update]);
		for (const issue of rowIssues) issues.add(issue);
	}
	const canUndo = issues.size === 0 && (roots.length > 0 || aliases.length > 0);
	const previewHash = canUndo ? clockifyHash([1, accountId, id, batch.committedAt, digestedEntries,
		aliases.map(({ fingerprint, occurrence, targetFingerprint, targetOccurrence }) => [fingerprint, occurrence, targetFingerprint, targetOccurrence])]) : null;
	return {
		batch: summary, canUndo, previewHash, entries, issues: [...issues],
		trashCount: roots.length, revertCount: updates.size, releaseIdentityCount: roots.length, releaseAliasCount: aliases.length,
	};
}

async function revertCorrection(transaction: Prisma.TransactionClient, accountId: string, update: CorrectionUpdate, at: Date, key: string) {
	const current = await transaction.entry.findUniqueOrThrow({ where: { accountId, id: update.entryId }, include: entryRelations });
	if (current.revision !== update.after.entry.revision || current.deletedAt || current.supersededAt || current.invoicedAt) undoChanged();
	const old = update.before.entry;
	await transaction.entryDayAllocation.deleteMany({ where: { entryId: current.id } });
	const restored = await transaction.entry.update({
		where: { id: current.id, accountId, revision: current.revision, deletedAt: null, supersededAt: null, invoicedAt: null },
		data: {
			kind: old.kind, description: old.description, localDate: old.localDate, durationSeconds: old.durationSeconds,
			startAt: old.kind === 'timed' ? new Date(old.startAt) : null, endAt: old.kind === 'timed' ? new Date(old.endAt) : null,
			projectId: old.projectId, directClientId: old.directClientId, billable: old.billable,
			assignedRateOrePerHour: old.assignedRateOrePerHour === null ? null : BigInt(old.assignedRateOrePerHour),
			billableAmountOre: old.billableAmountOre === null ? null : BigInt(old.billableAmountOre),
			completion: old.completion, revision: { increment: 1 },
			allocations: { createMany: { data: update.before.allocations.map(({ amountOre, ...allocation }) => ({
				...allocation, amountOre: BigInt(amountOre),
			})) } },
		},
		include: entryRelations,
	});
	await recordHistory(transaction, 'clockify-undo', at, entryResponse(restored), entryResponse(current), key);
}

export function createClockifyUndo(database: PrismaClient, now: () => Date) {
	return {
		async listBatches(accountId: string, query: ClockifyImportBatchListQuery) {
			return database.$transaction(async (transaction) => {
				const cursor = query.cursor ? await transaction.clockifyImportBatch.findUnique({
					where: { id: query.cursor, accountId }, select: batchDates,
				}) : null;
				if (query.cursor && !cursor) batchNotFound();
				const rows = await transaction.clockifyImportBatch.findMany({
					where: { accountId, ...(cursor ? { OR: [
						{ committedAt: { lt: cursor.committedAt } }, { committedAt: cursor.committedAt, id: { lt: cursor.id } },
					] } : {}) },
					select: batchDates, orderBy: [{ committedAt: 'desc' }, { id: 'desc' }], take: maxUndoPageSize + 1,
				});
				const page = rows.slice(0, maxUndoPageSize);
				const batches = [];
				for (const { id } of page) batches.push(readBatch(await batchEntry(transaction, accountId, id)).summary);
				return { batches, nextCursor: rows.length > maxUndoPageSize ? page.at(-1)!.id : null };
			});
		},

		previewUndo(accountId: string, id: string) {
			return database.$transaction((transaction) => planUndo(transaction, accountId, id));
		},

		undo(accountId: string, id: string, previewHash: string, key: string) {
			return writeWithReceipt(database, accountId, key, ['clockify.undo', id, previewHash], parseClockifyUndoCommitResponse, async (transaction) => {
				const preview = await planUndo(transaction, accountId, id);
				if (preview.batch.undoneAt) {
					throw new ApiRequestError(409, 'CLOCKIFY_BATCH_ALREADY_UNDONE', 'This Clockify import was already undone.');
				}
				if (!preview.canUndo || previewHash !== preview.previewHash) undoChanged();
				const at = now();
				const batch = await batchEntry(transaction, accountId, id);
				const { updates } = readBatch(batch);
				if (!Value.Check(CorrectionUpdates, updates)) undoChanged();

				const roots = await transaction.clockifyImportIdentity.findMany({
					where: { accountId, batchId: id }, orderBy: [{ fingerprint: 'asc' }, { occurrence: 'asc' }],
				});
				const aliases = await transaction.clockifyImportAlias.findMany({
					where: { accountId, batchId: id }, orderBy: [{ fingerprint: 'asc' }, { occurrence: 'asc' }],
				});
				for (const root of roots) {
					const current = await transaction.entry.findUniqueOrThrow({ where: { id: root.entryId, accountId }, include: entryRelations });
					await trashImportedEntry(transaction, current, at, key);
					await transaction.clockifyReleasedIdentity.create({ data: root });
				}
				for (const update of updates) await revertCorrection(transaction, accountId, update, at, key);

				const releasedAliases = await transaction.clockifyImportAlias.deleteMany({ where: { accountId, batchId: id } });
				const releasedRoots = await transaction.clockifyImportIdentity.deleteMany({ where: { accountId, batchId: id } });
				if (releasedRoots.count !== preview.releaseIdentityCount || releasedAliases.count !== preview.releaseAliasCount) undoChanged();

				await transaction.clockifyImportBatch.update({
					where: { id, accountId, undoneAt: null },
					data: { undoneAt: at, undoSnapshot: JSON.stringify({ version: 1, operationKey: key, aliases,
						roots: roots.map(({ fingerprint, occurrence, entryId }) => ({ fingerprint, occurrence, entryId })) }) },
				});
				return { batchId: id, undoneAt: at.toISOString(), serverNow: at.toISOString(), trashedCount: preview.trashCount,
					revertedCount: preview.revertCount, releasedIdentityCount: releasedRoots.count, releasedAliasCount: releasedAliases.count };
			}, undoTimeoutMs);
		},
	};
}
