interface PendingImport {
	previewToken: string;
	key: string;
}

const storageKey = 'timekeeper.clockify-import';

export function readPendingClockifyImport(account: string): PendingImport | null {
	try {
		const raw = sessionStorage.getItem(storageKey);
		if (!raw) return null;
		const { owner, pending } = JSON.parse(raw);
		if (owner !== account || typeof pending?.key !== 'string' || typeof pending.previewToken !== 'string') return null;
		return pending;
	} catch {
		return null;
	}
}

export function writePendingClockifyImport(account: string, pending: PendingImport | null) {
	try {
		if (pending) sessionStorage.setItem(storageKey, JSON.stringify({ owner: account, pending }));
		else if (readPendingClockifyImport(account)) sessionStorage.removeItem(storageKey);
	} catch {
		// The request can still be retried in the current visit.
	}
}

export type { PendingImport };
