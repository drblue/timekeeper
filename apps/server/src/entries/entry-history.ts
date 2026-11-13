import { randomUUID } from 'node:crypto';
import { parseEntryResponse } from '@timekeeper/contracts';
import type { EntryHistoryAction, EntryResponse } from '@timekeeper/contracts';
import type { Prisma } from '../generated/prisma/client.ts';

export async function recordHistory(
	transaction: Prisma.TransactionClient, action: EntryHistoryAction, at: Date,
	after: EntryResponse, before?: EntryResponse, operationKey?: string,
) {
	await transaction.entryHistory.create({ data: {
		id: randomUUID(), entryId: after.id, action, at, operationKey,
		beforeSnapshot: before ? JSON.stringify({ version: 1, entry: before }) : null,
		afterSnapshot: JSON.stringify({ version: 1, entry: after }),
	} });
}

export function readHistorySnapshot(snapshot: string, id: string): EntryResponse {
	const parsed: unknown = JSON.parse(snapshot);
	if (!parsed || typeof parsed !== 'object' || !('version' in parsed) || parsed.version !== 1 || !('entry' in parsed)) {
		throw new Error('Invalid time entry history snapshot');
	}
	const entry = parseEntryResponse(parsed.entry);
	if (entry.id !== id) throw new Error('Time entry history refers to another entry');
	return entry;
}
