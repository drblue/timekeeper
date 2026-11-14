import { entriesPath } from '@timekeeper/contracts';
import { ApiRequestError, writeApi } from './api';
import type { RefreshSession } from './api';
import { authError } from './auth';

type Action = 'delete' | 'restore';

export async function changeEntryLifecycle<T>(
	action: Action, entry: { id: string; revision: number }, csrfToken: string, parse: (value: unknown) => T,
): Promise<T> {
	const response = await writeApi(`${entriesPath}/${encodeURIComponent(entry.id)}/${action}`,
		'POST', csrfToken, { revision: entry.revision }, { signal: AbortSignal.timeout(10_000) });
	return parse(await response.json());
}

export async function entryLifecycleError(error: unknown, action: Action, refresh: RefreshSession) {
	if (error instanceof ApiRequestError) {
		if (error.response.status === 401 || error.response.status === 403) return authError(error.response, refresh);
		switch (error.code) {
			case 'ENTRY_INVOICED':
				return 'This entry is invoiced. Unmark it before moving it to Trash.';
			case 'REVISION_CONFLICT':
				return 'This entry changed in another session. Check the latest details before trying again.';
			case 'ENTRY_ALREADY_DELETED':
				return 'This entry is already in Trash.';
			case 'ENTRY_NOT_DELETED':
				return 'This entry is no longer in Trash.';
			case 'ENTRY_RESTORE_EXPIRED':
				return 'The restore deadline has passed. This entry can no longer be restored.';
			case 'CLOCKIFY_REIMPORTED':
				return 'This Clockify occurrence has already been reimported. Review the active entry before restoring from Trash.';
		}
		if (error.response.status === 404) return 'This entry is no longer available.';
	}
	return action === 'delete'
		? 'Could not confirm the move to Trash. Check the saved entry before trying again.'
		: 'Could not confirm restoration. Check Trash before trying again.';
}
