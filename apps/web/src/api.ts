import { csrfHeader } from '@timekeeper/contracts';

export type RefreshSession = () => Promise<unknown>;

export class ApiRequestError extends Error {
	constructor(readonly response: Response, readonly code: string | undefined) {
		super('Timekeeper rejected the request.');
	}
}

async function requestError(response: Response) {
	const payload: unknown = await response.clone().json().catch(() => undefined);
	const code = payload && typeof payload === 'object' && 'code' in payload && typeof payload.code === 'string'
		? payload.code
		: undefined;
	return new ApiRequestError(response, code);
}

export async function readApi<T>(
	path: string,
	parse: (value: unknown) => T,
	signal: AbortSignal,
	refreshSession: RefreshSession,
): Promise<T> {
	const response = await fetch(path, { signal, cache: 'no-store' });
	if (response.status === 401) {
		await refreshSession();
	}
	if (!response.ok) {
		throw await requestError(response);
	}
	return parse(await response.json());
}

export async function writeApi(
	path: string, method: 'POST' | 'PUT', csrfToken: string, body: object,
	options?: { headers?: Record<string, string>; signal?: AbortSignal },
) {
	const response = await fetch(path, {
		method,
		cache: 'no-store',
		headers: { ...options?.headers, 'Content-Type': 'application/json', [csrfHeader]: csrfToken },
		signal: options?.signal,
		body: JSON.stringify(body),
	});
	if (!response.ok) {
		throw await requestError(response);
	}
	return response;
}
