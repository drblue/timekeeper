import { randomUUID } from 'node:crypto';
import { parseBulkEntryCommitResponse } from '@timekeeper/contracts';
import type { BulkEntryCommitResponse, BulkEntryPreviewBody, BulkEntryPreviewResponse, WorkListQuery, WorkListRange } from '@timekeeper/contracts';
import { writeForAccount } from '../account-write.ts';
import { ApiRequestError } from '../api-error.ts';
import type { Prisma, PrismaClient } from '../generated/prisma/client.ts';
import { writeWithReceipt } from '../operation-receipt.ts';
import { changeEntryDeletion, requireUninvoicedEntry } from './entry-deletion.ts';
import { activeEntryWhere, entryRelations } from './entry-record.ts';
import type { EntryWithRelations } from './entry-record.ts';
import { invoiceMetadata, writeInvoiceChange } from './invoicing.ts';
import type { InvoiceMetadata } from './invoicing.ts';
import { readCompletedWork, readIncompleteWork, resolveWorkScope, totalWork, workDateRange } from './work-scope.ts';

const previewLifetimeMs = 15 * 60 * 1_000;
type BulkAction = BulkEntryPreviewBody['action'];
type Selection = BulkEntryPreviewBody['selection'];
type PreviewItem = BulkEntryPreviewResponse['entries'][number];
type SelectionFilters = Pick<WorkListQuery, 'clientId' | 'projectId' | 'invoice' | 'billability' | 'description' | 'invoiceNumber'>;

interface PreviewSnapshot {
	version: 1;
	action: BulkAction;
	range: WorkListRange;
	filters: SelectionFilters;
	selection: Selection;
	metadata: InvoiceMetadata | null;
	versions: { id: string; revision: number }[];
}

function stalePreview(): never {
	throw new ApiRequestError(409, 'BULK_PREVIEW_CHANGED', 'The selected work changed. Review a new preview before applying.');
}

function selectionFilters({ clientId, projectId, invoice, billability, description, invoiceNumber }: WorkListQuery): SelectionFilters {
	return { clientId, projectId, invoice, billability, description: description?.trim(), invoiceNumber: invoiceNumber?.trim() };
}

function previewItem(entry: EntryWithRelations, action: BulkAction, range: WorkListRange, inSelection: boolean): PreviewItem {
	const issues: PreviewItem['issues'] = [];
	if (!inSelection) issues.push('outside-selection');
	if (action === 'mark-invoiced') {
		if (entry.completion !== 'complete') issues.push('not-completed');
		if (!entry.billable) issues.push('non-billable');
		if (entry.invoicedAt) issues.push('already-invoiced');
		if (entry.allocations.some(({ localDate }) => localDate < range.from || localDate > range.to)) issues.push('outside-date-range');
	} else if (action === 'unmark-invoiced' && !entry.invoicedAt) {
		issues.push('not-invoiced');
	} else if (action === 'delete' && entry.invoicedAt) {
		issues.push('invoiced-delete');
	}
	return {
		id: entry.id, revision: entry.revision, description: entry.description, seconds: entry.durationSeconds,
		amountOre: entry.billableAmountOre?.toString() ?? null, issues,
	};
}

async function resolveSelection(
	transaction: Prisma.TransactionClient, accountId: string, range: WorkListRange, filters: SelectionFilters, selection: Selection,
) {
	const scope = await resolveWorkScope(transaction, accountId, range, filters);
	const explicitIds = selection.mode === 'explicit' ? selection.entryIds : undefined;
	const completed = await readCompletedWork(transaction, scope, explicitIds);
	const incomplete = await readIncompleteWork(transaction, scope, { allocations: false }, explicitIds);
	const matchingIds = new Set([...completed.map(({ entryId }) => entryId), ...incomplete.map(({ id }) => id)]);
	const selectedIds = explicitIds ?? [...matchingIds];
	const entries = selectedIds.length ? await transaction.entry.findMany({
		where: { ...activeEntryWhere(accountId), id: { in: selectedIds } }, include: entryRelations, orderBy: { id: 'asc' },
	}) : [];
	if (entries.length !== selectedIds.length) {
		throw new ApiRequestError(422, 'INVALID_BULK_SELECTION', 'Some selected entries are unavailable. Refresh the work list.');
	}
	return { entries, matchingIds };
}

export function createBulkEntryStore(database: PrismaClient, now: () => Date) {
	return {
		async previewBulkEntries(accountId: string, input: BulkEntryPreviewBody): Promise<BulkEntryPreviewResponse> {
			const at = now();
			const range = workDateRange(input.filters, at.toISOString());
			const filters = selectionFilters(input.filters);
			const { action } = input;
			const selection: Selection = input.selection.mode === 'explicit'
				? { mode: 'explicit', entryIds: [...new Set(input.selection.entryIds)].sort() }
				: input.selection;
			if (input.metadata && action !== 'mark-invoiced') {
				throw new ApiRequestError(422, 'INVALID_BULK_SELECTION', 'Invoice metadata only applies when marking work as invoiced.');
			}
			const metadata = action === 'mark-invoiced' ? invoiceMetadata(input.metadata ?? {}) : null;
			const resolved = await database.$transaction((transaction) => resolveSelection(transaction, accountId, range, filters, selection));
			const { entries, matchingIds } = resolved;
			const items = entries.map((entry) => previewItem(entry, action, range, matchingIds.has(entry.id)));
			const totals = totalWork(entries.map(({ durationSeconds, billableAmountOre }) =>
				({ seconds: durationSeconds, amountOre: billableAmountOre })));
			const canCommit = items.length > 0 && items.every(({ issues }) => issues.length === 0);
			const previewToken = canCommit ? randomUUID() : null;
			if (previewToken) {
				const snapshot: PreviewSnapshot = { version: 1, action, range, filters, selection, metadata,
					versions: entries.map(({ id, revision }) => ({ id, revision })) };
				await writeForAccount(database, accountId, async (transaction) => {
					const expired = await transaction.bulkEntryPreview.findMany({
						where: { accountId, expiresAt: { lte: at } }, select: { id: true }, take: 100,
					});
					if (expired.length) await transaction.bulkEntryPreview.deleteMany({ where: { accountId, id: { in: expired.map(({ id }) => id) } } });
					await transaction.bulkEntryPreview.create({ data: {
						id: previewToken, accountId, snapshot: JSON.stringify(snapshot), expiresAt: new Date(at.getTime() + previewLifetimeMs),
					} });
				});
			}
			return { action, range, count: items.length, seconds: totals.seconds, amountOre: totals.amountOre.toString(),
				entries: items, canCommit, previewToken };
		},

		commitBulkEntries(accountId: string, key: string, token: string): Promise<BulkEntryCommitResponse> {
			return writeWithReceipt(database, accountId, key, ['entries.bulk', token], parseBulkEntryCommitResponse, async (transaction) => {
				const stored = await transaction.bulkEntryPreview.findUnique({ where: { id: token, accountId } });
				if (!stored) throw new ApiRequestError(422, 'INVALID_BULK_PREVIEW', 'This preview is unavailable. Review the selected work again.');
				const at = now();
				if (stored.consumedAt) stalePreview();
				if (at >= stored.expiresAt) throw new ApiRequestError(409, 'BULK_PREVIEW_EXPIRED', 'This preview expired. Review the selected work again.');
				const snapshot = JSON.parse(stored.snapshot) as PreviewSnapshot;
				if (snapshot.version !== 1) throw new Error('Invalid bulk preview version');
				const { action, range, filters, selection, metadata, versions } = snapshot;
				const { entries, matchingIds } = await resolveSelection(transaction, accountId, range, filters, selection).catch((error: unknown) => {
					if (error instanceof ApiRequestError) stalePreview();
					throw error;
				});
				if (entries.length !== versions.length || entries.some((entry, index) => {
					const approved = versions[index];
					return entry.id !== approved?.id || entry.revision !== approved.revision
						|| previewItem(entry, action, range, matchingIds.has(entry.id)).issues.length > 0;
				})) stalePreview();
				for (const entry of entries) {
					if (action === 'delete') {
						requireUninvoicedEntry(entry, 'deleting');
						await changeEntryDeletion(transaction, entry, at, at, key);
					} else if (action === 'unmark-invoiced') {
						await writeInvoiceChange(transaction, entry, { action: 'invoice-unmarked' }, at, key);
					} else {
						if (!metadata) throw new Error('Missing bulk invoice metadata');
						await writeInvoiceChange(transaction, entry, { action: 'invoice-marked', metadata }, at, key);
					}
				}
				await transaction.bulkEntryPreview.update({ where: { id: token, accountId }, data: { consumedAt: at } });
				return { action, count: entries.length, entryIds: entries.map(({ id }) => id), serverNow: at.toISOString() };
			});
		},
	};
}
