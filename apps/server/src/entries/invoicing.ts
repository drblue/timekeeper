import type { EntryInvoiceBody, EntryResponse } from '@timekeeper/contracts';
import { writeForAccount } from '../account-write.ts';
import { ApiRequestError } from '../api-error.ts';
import type { Prisma, PrismaClient } from '../generated/prisma/client.ts';
import { validLocalDate } from '../local-date.ts';
import { recordHistory } from './entry-history.ts';
import { activeEntryWhere, checkEntryRevision, entryRelations, entryResponse } from './entry-record.ts';
import type { EntryWithRelations } from './entry-record.ts';

export interface InvoiceMetadata {
	invoiceNumber: string | null;
	invoiceDate: string | null;
	invoiceReference: string | null;
}

export function invoiceMetadata(input: Omit<EntryInvoiceBody, 'revision'>): InvoiceMetadata {
	const invoiceDate = input.invoiceDate || null;
	if (invoiceDate !== null && !validLocalDate(invoiceDate)) {
		throw new ApiRequestError(422, 'INVALID_INVOICE_DATE', 'Enter a valid invoice date.', 'invoiceDate');
	}
	return { invoiceDate, invoiceNumber: input.invoiceNumber?.trim() || null, invoiceReference: input.invoiceReference?.trim() || null };
}

const emptyMetadata: InvoiceMetadata = { invoiceNumber: null, invoiceDate: null, invoiceReference: null };

export function requireInvoiceEligibility(entry: { invoicedAt: Date | null; completion: string; billable: boolean }) {
	if (entry.invoicedAt) throw new ApiRequestError(409, 'ENTRY_ALREADY_INVOICED', 'This entry is already invoiced.');
	if (entry.completion !== 'complete' || !entry.billable) {
		throw new ApiRequestError(422, 'ENTRY_NOT_INVOICE_ELIGIBLE', 'Only completed billable entries can be marked as invoiced.');
	}
}

type InvoiceChange =
	| { action: 'invoice-marked' | 'invoice-metadata-updated'; metadata: InvoiceMetadata }
	| { action: 'invoice-unmarked' };

export async function writeInvoiceChange(
	transaction: Prisma.TransactionClient, current: EntryWithRelations, change: InvoiceChange, at: Date,
): Promise<EntryResponse> {
	const { action } = change;
	if (action === 'invoice-marked') requireInvoiceEligibility(current);
	else if (!current.invoicedAt) throw new ApiRequestError(409, 'ENTRY_NOT_INVOICED', 'This entry is not marked as invoiced.');

	const metadata = action === 'invoice-unmarked' ? emptyMetadata : change.metadata;
	if (action === 'invoice-metadata-updated' && current.invoiceNumber === metadata.invoiceNumber
		&& current.invoiceDate === metadata.invoiceDate && current.invoiceReference === metadata.invoiceReference) {
		return entryResponse(current);
	}
	// The writer transaction already checked the marking state. Keep the stored timestamp untouched on metadata corrections.
	const invoicedAt = action === 'invoice-marked' ? at : action === 'invoice-unmarked' ? null : undefined;
	const updated = await transaction.entry.update({
		where: { id: current.id, ...activeEntryWhere(current.accountId), revision: current.revision },
		data: { ...metadata, invoicedAt, revision: { increment: 1 } }, include: entryRelations,
	});
	const response = entryResponse(updated);
	await recordHistory(transaction, action, at, response, entryResponse(current));
	return response;
}

export function createEntryInvoiceStore(database: PrismaClient, now: () => Date) {
	function changeInvoice(accountId: string, id: string, revision: number, change: InvoiceChange) {
		return writeForAccount(database, accountId, async (transaction) => {
			const current = await transaction.entry.findUnique({ where: { id, ...activeEntryWhere(accountId) }, include: entryRelations });
			if (!current) throw new ApiRequestError(404, 'NOT_FOUND', 'Time entry was not found.');
			checkEntryRevision(current, revision);
			return writeInvoiceChange(transaction, current, change, now());
		});
	}

	return {
		markInvoiced(accountId: string, id: string, input: EntryInvoiceBody) {
			return changeInvoice(accountId, id, input.revision, { action: 'invoice-marked', metadata: invoiceMetadata(input) });
		},
		updateInvoiceMetadata(accountId: string, id: string, input: EntryInvoiceBody) {
			return changeInvoice(accountId, id, input.revision, { action: 'invoice-metadata-updated', metadata: invoiceMetadata(input) });
		},
		unmarkInvoiced(accountId: string, id: string, revision: number) {
			return changeInvoice(accountId, id, revision, { action: 'invoice-unmarked' });
		},
	};
}
