import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
	authSessionPath,
	csrfHeader,
	parseAuthSessionResponse,
} from '@timekeeper/contracts';
import type { AuthSessionResponse } from '@timekeeper/contracts';
import { createContext, use } from 'react';

const sessionKey = [authSessionPath];

function removePrivateQueries(queryClient: ReturnType<typeof useQueryClient>) {
	queryClient.removeQueries({ predicate: ({ queryKey }) => queryKey[0] !== authSessionPath });
}

async function readSession(signal?: AbortSignal) {
	const response = await fetch(authSessionPath, { signal, cache: 'no-store' });
	return readSessionResponse(response);
}

export async function readSessionResponse(response: Response) {
	if (!response.ok) {
		throw new Error('Could not check your session.');
	}
	const payload: unknown = await response.json();
	return parseAuthSessionResponse(payload);
}

export function useSessionQuery() {
	const queryClient = useQueryClient();

	return useQuery({
		queryKey: sessionKey,
		queryFn: async ({ signal }) => {
			const session = await readSession(signal);
			if (!session.account) {
				removePrivateQueries(queryClient);
			}
			return session;
		},
		retry: false,
		networkMode: 'always',
		refetchInterval: (query) => query.state.data?.account ? 30_000 : false,
	});
}

export function useReplaceSession() {
	const queryClient = useQueryClient();

	return async (session: AuthSessionResponse | undefined) => {
		await queryClient.cancelQueries({ queryKey: sessionKey });
		if (!session?.account) {
			removePrivateQueries(queryClient);
		}
		if (session) {
			queryClient.setQueryData(sessionKey, session);
		} else {
			// Logout has already succeeded. Drop the old session before fetching a fresh CSRF token.
			await queryClient.resetQueries({ queryKey: sessionKey });
		}
	};
}

type SessionContextValue = {
	session: AuthSessionResponse;
	refresh: () => Promise<unknown>;
};

export const SessionContext = createContext<SessionContextValue | null>(null);

export function useSession() {
	const context = use(SessionContext);
	if (!context) {
		throw new Error('Missing session context');
	}
	return context;
}

export function postAuth(path: string, csrfToken: string, body?: Record<string, string>) {
	return fetch(path, {
		method: 'POST',
		cache: 'no-store',
		headers: {
			[csrfHeader]: csrfToken,
			...(body ? { 'Content-Type': 'application/json' } : {}),
		},
		body: body ? JSON.stringify(body) : undefined,
	});
}

export async function authError(response: Response, refresh: SessionContextValue['refresh']) {
	const payload: unknown = await response.json().catch(() => undefined);
	const code = payload && typeof payload === 'object' && 'code' in payload ? payload.code : undefined;

	switch (code) {
		case 'AUTH_REQUIRED':
			await refresh();
			return 'Your session ended. Sign in again.';
		case 'CSRF_REJECTED':
			await refresh();
			return 'Your session changed. Try again.';
		case 'ORIGIN_REJECTED':
			return 'Open Timekeeper at its usual address and try again.';
		case 'INVALID_CREDENTIALS':
			return 'The email or password is incorrect. Check both and try again.';
		case 'INVALID_CURRENT_PASSWORD':
			return 'The current password is incorrect. Try again.';
		case 'INVALID_PASSWORD':
			return 'Choose a new password that meets the requirements below.';
		case 'LOGIN_RATE_LIMITED':
		case 'PASSWORD_RATE_LIMITED': {
			const seconds = Number(response.headers.get('Retry-After'));
			if (!Number.isFinite(seconds) || seconds <= 0) {
				return 'Too many attempts. Wait a few minutes before trying again.';
			}
			const wait = seconds >= 60 ? Math.ceil(seconds / 60) : Math.ceil(seconds);
			const unit = seconds >= 60 ? 'minute' : 'second';
			return `Too many attempts. Try again in ${wait} ${unit}${wait === 1 ? '' : 's'}.`;
		}
		case 'INVALID_REQUEST':
			return 'Check the values you entered and try again.';
		default:
			return 'Timekeeper could not complete the request. Try again.';
	}
}
