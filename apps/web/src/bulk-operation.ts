import type { BulkEntryCommitBody, BulkEntryPreviewBody } from '@timekeeper/contracts';

export interface BulkOperation extends BulkEntryCommitBody {
	key: string;
	action: BulkEntryPreviewBody['action'];
	count: number;
}

const storageKey = 'timekeeper.bulk-operation';

export function readBulkOperation(account: string): BulkOperation | null {
	try {
		const raw = sessionStorage.getItem(storageKey);
		if (!raw) return null;
		const { account: owner, operation } = JSON.parse(raw);
		if (owner !== account || !['mark-invoiced', 'unmark-invoiced', 'delete'].includes(operation?.action) ||
			typeof operation.key !== 'string' || typeof operation.previewToken !== 'string' ||
			!Number.isSafeInteger(operation.count) || operation.count < 1) return null;
		return operation;
	} catch {
		return null;
	}
}

export function writeBulkOperation(account: string, operation: BulkOperation | null) {
	try {
		if (operation) {
			sessionStorage.setItem(storageKey, JSON.stringify({ account, operation }));
		} else if (readBulkOperation(account)) {
			sessionStorage.removeItem(storageKey);
		}
	} catch {
		// Keep the request available to retry for the current visit.
	}
}
