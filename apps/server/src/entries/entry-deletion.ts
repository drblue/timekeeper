import type { EntryResponse } from '@timekeeper/contracts';
import { ApiRequestError } from '../api-error.ts';
import type { Prisma } from '../generated/prisma/client.ts';
import { recordHistory } from './entry-history.ts';
import { entryRelations, entryResponse } from './entry-record.ts';
import type { EntryWithRelations } from './entry-record.ts';

export function requireUninvoicedEntry(current: EntryWithRelations, action: 'editing' | 'deleting') {
	if (current.invoicedAt) throw new ApiRequestError(409, 'ENTRY_INVOICED', `Unmark this entry as invoiced before ${action} it.`);
}

export async function changeEntryDeletion(
	transaction: Prisma.TransactionClient, current: EntryWithRelations, deletedAt: Date | null, now: Date, operationKey?: string,
): Promise<EntryResponse> {
	const { id, accountId, revision } = current;
	const updated = await transaction.entry.update({
		where: { id, accountId, revision, supersededAt: null, deletedAt: current.deletedAt, ...(deletedAt ? { invoicedAt: null } : {}) },
		data: { deletedAt, revision: { increment: 1 } }, include: entryRelations,
	});
	const response = entryResponse(updated);
	await recordHistory(transaction, deletedAt ? 'deleted' : 'restored', now, response, entryResponse(current), operationKey);
	return response;
}
