import { clientsPath, maxHourlyRateOre, projectsPath } from '@timekeeper/contracts';
import type { ClientResponse, ProjectResponse } from '@timekeeper/contracts';
import { ApiRequestError, readApi } from './api';
import type { RefreshSession } from './api';
import { authError } from './auth';
import { rateInputValue } from './money';

export const catalogKey = ['catalog'] as const;
export const catalogPaths = { client: clientsPath, project: projectsPath } as const;
export type CatalogKind = keyof typeof catalogPaths;
export type CatalogRecord = ClientResponse | ProjectResponse;

export async function readCatalog<T>(
	path: string,
	parse: (value: unknown) => T,
	signal: AbortSignal,
	refreshSession: RefreshSession,
): Promise<T> {
	return readApi(`${path}?view=management`, parse, signal, refreshSession);
}

export async function describeCatalogError(error: unknown, refreshSession: RefreshSession, fallback: string) {
	if (!(error instanceof ApiRequestError)) {
		return fallback;
	}
	if (error.response.status === 401 || error.response.status === 403) {
		return authError(error.response, refreshSession);
	}
	switch (error.code) {
		case 'PROJECT_CLIENT_LOCKED':
			return 'This project has time entries. Select its original client to save other changes.';
		case 'REVISION_CONFLICT':
			return 'This record changed since you opened it. Reload the saved details before trying again.';
		case 'INVALID_CLIENT':
			return 'That client is unavailable. Choose an active client or leave the project without a client.';
		case 'INVALID_NAME':
			return 'Enter a name within the supported length.';
		case 'INVALID_NOTES':
			return 'Shorten the notes and try again.';
		case 'INVALID_HOURLY_RATE':
			return `Enter an hourly rate of ${rateInputValue(maxHourlyRateOre)} SEK or less.`;
		case 'INVALID_REQUEST':
			return 'Check the values you entered and try again.';
		case 'NOT_FOUND':
			return 'This record is unavailable. Refresh the list before trying again.';
		default:
			return fallback;
	}
}
