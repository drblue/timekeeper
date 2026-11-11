import { clientsPath, csrfHeader, maxHourlyRateOre, projectsPath } from '@timekeeper/contracts';
import type { ClientResponse, ProjectResponse } from '@timekeeper/contracts';
import { authError } from './auth';

export const catalogKey = ['catalog'] as const;
export const catalogPaths = { client: clientsPath, project: projectsPath } as const;
export type CatalogKind = keyof typeof catalogPaths;
export type CatalogRecord = ClientResponse | ProjectResponse;

type RefreshSession = () => Promise<unknown>;

export class CatalogRequestError extends Error {
	constructor(readonly response: Response, readonly code: string | undefined) {
		super('Timekeeper rejected the catalog request.');
	}
}

export async function readCatalog<T>(
	path: string,
	parse: (value: unknown) => T,
	signal: AbortSignal,
	refreshSession: RefreshSession,
): Promise<T> {
	const response = await fetch(`${path}?view=management`, { signal, cache: 'no-store' });
	if (response.status === 401) {
		await refreshSession();
	}
	if (!response.ok) {
		throw new Error('Timekeeper could not load the catalog.');
	}
	return parse(await response.json());
}

export async function writeCatalog(path: string, method: 'POST' | 'PUT', csrfToken: string, body: object) {
	const response = await fetch(path, {
		method,
		cache: 'no-store',
		headers: { 'Content-Type': 'application/json', [csrfHeader]: csrfToken },
		body: JSON.stringify(body),
	});
	if (!response.ok) {
		const payload: unknown = await response.clone().json().catch(() => undefined);
		const code = payload && typeof payload === 'object' && 'code' in payload && typeof payload.code === 'string'
			? payload.code
			: undefined;
		throw new CatalogRequestError(response, code);
	}
}

export async function describeCatalogError(error: unknown, refreshSession: RefreshSession, fallback: string) {
	if (!(error instanceof CatalogRequestError)) {
		return fallback;
	}
	if (error.response.status === 401 || error.response.status === 403) {
		return authError(error.response, refreshSession);
	}
	switch (error.code) {
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

export function rateInputValue(ore: string | null): string {
	if (ore === null) return '';
	const digits = ore.padStart(3, '0');
	return `${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

const wholeKronor = new Intl.NumberFormat('en', { maximumFractionDigits: 0 });

export function formatHourlyRate(ore: string): string {
	const digits = ore.padStart(3, '0');
	return `${wholeKronor.format(BigInt(digits.slice(0, -2)))}.${digits.slice(-2)} SEK/hour`;
}

export function parseHourlyRate(input: string): string | null {
	const text = input.trim();
	if (!text) return null;
	const [, whole, fraction = ''] = /^(\d{1,20})(?:[.,](\d{1,2}))?$/.exec(text) ?? [];
	if (whole === undefined) {
		throw new Error('Enter the hourly rate in SEK with up to two decimal places, or leave it blank.');
	}
	const ore = BigInt(whole + fraction.padEnd(2, '0'));
	if (ore > BigInt(maxHourlyRateOre)) {
		throw new Error(`Enter an hourly rate of ${rateInputValue(maxHourlyRateOre)} SEK or less.`);
	}
	return ore.toString();
}
