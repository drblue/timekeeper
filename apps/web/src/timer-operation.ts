import type { StartTimerRequest, StopTimerBody, SwitchTimerBody } from '@timekeeper/contracts';

export type TimerOperation =
	| { kind: 'start'; key: string; body: StartTimerRequest }
	| { kind: 'stop'; key: string; body: StopTimerBody }
	| { kind: 'switch'; key: string; body: SwitchTimerBody };

const storageKey = 'timekeeper.timer-operation';

export function readTimerOperation(account: string): TimerOperation | null {
	try {
		const raw = sessionStorage.getItem(storageKey);
		if (!raw) return null;
		const stored = JSON.parse(raw);
		if (stored.account !== account || !['start', 'stop', 'switch'].includes(stored.operation?.kind) ||
			typeof stored.operation.key !== 'string' || !stored.operation.body) return null;
		return stored.operation;
	} catch {
		return null;
	}
}

export function writeTimerOperation(account: string, operation: TimerOperation | null) {
	try {
		if (operation) {
			sessionStorage.setItem(storageKey, JSON.stringify({ account, operation }));
		} else {
			const raw = sessionStorage.getItem(storageKey);
			if (raw && JSON.parse(raw).account === account) sessionStorage.removeItem(storageKey);
		}
	} catch {
		// The pending request can still be retried until this tab reloads.
	}
}

export function operationKey() {
	// randomUUID is limited to secure contexts, while the app can run on a private HTTP host.
	if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	const hex = Array.from(bytes, (byte, index) => {
		if (index === 6) byte = (byte & 15) | 64;
		if (index === 8) byte = (byte & 63) | 128;
		return byte.toString(16).padStart(2, '0');
	}).join('');
	return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}
