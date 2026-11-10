import { createHmac, timingSafeEqual } from 'node:crypto';
import cookie from '@fastify/cookie';
import { Type } from '@sinclair/typebox';
import {
	accountPath,
	AccountResponse,
	ApiErrorResponse,
	authLoginPath,
	authLogoutPath,
	authPasswordPath,
	authSessionPath,
	AuthSessionResponse,
	ChangePasswordBody,
	csrfHeader,
	LoginBody,
} from '@timekeeper/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AuthConfig } from './config.ts';
import { canonicalAddress } from './config.ts';
import { createAuthLimits } from './limits.ts';
import { normalizeEmail, passwordLengthMessage, validNewPassword } from './passwords.ts';
import type { AccountSession, AuthStore } from './store.ts';
import { randomToken, sessionMaxAge } from './store.ts';

declare module 'fastify' {
	interface FastifyContextConfig {
		publicAccess?: boolean;
	}

	interface FastifyRequest {
		accountSession: AccountSession | null;
	}
}

export interface AuthOptions {
	config: AuthConfig;
	store: AuthStore;
}

const tokenPattern = /^[A-Za-z0-9_-]{43}$/;

function reject(request: FastifyRequest, reply: FastifyReply, status: number, code: string, message: string) {
	return reply.code(status).send({ code, message, requestId: request.id } satisfies ApiErrorResponse);
}

function requireAccount(request: FastifyRequest, reply: FastifyReply) {
	return reject(request, reply, 401, 'AUTH_REQUIRED', 'Sign in to continue.');
}

function rateLimited(request: FastifyRequest, reply: FastifyReply, retryAfter: number, code = 'LOGIN_RATE_LIMITED') {
	reply.header('Retry-After', retryAfter);
	return reject(request, reply, 429, code, 'Too many attempts. Wait and try again.');
}

function deriveCsrfToken(secret: string): string {
	return createHmac('sha256', secret).update('timekeeper-csrf-v1').digest('base64url');
}

export async function registerAccountAccess(app: FastifyInstance, auth?: AuthOptions) {
	app.decorateRequest('accountSession', null);

	if (!auth) {
		app.addHook('onRequest', async (request, reply) => {
			if (request.routeOptions.url && !request.routeOptions.config.publicAccess) {
				reply.header('Cache-Control', 'no-store');
				return requireAccount(request, reply);
			}
		});
		return;
	}

	await app.register(cookie);

	const { config, store } = auth;
	const secure = config.origin.startsWith('https:');
	const prefix = secure ? '__Host-' : '';
	const sessionCookie = `${prefix}timekeeper-session`;
	const preAuthCookie = `${prefix}timekeeper-csrf`;
	const cookieOptions = { httpOnly: true, secure, sameSite: 'strict', path: '/' } as const;
	const limits = createAuthLimits();

	function tokenCookie(request: FastifyRequest, name: string): string | undefined {
		const token = request.cookies[name];
		return token && tokenPattern.test(token) ? token : undefined;
	}

	async function loadSession(request: FastifyRequest) {
		const token = tokenCookie(request, sessionCookie);
		request.accountSession = token ? await store.findSession(token) : null;
	}

	function rejectWrongOrigin(request: FastifyRequest, reply: FastifyReply) {
		if (request.headers.origin !== config.origin) {
			return reject(request, reply, 403, 'ORIGIN_REJECTED', 'Open Timekeeper at its configured address and try again.');
		}
	}

	function rejectWrongCsrf(request: FastifyRequest, reply: FastifyReply, secret: string | undefined) {
		const candidate = request.headers[csrfHeader];
		if (!secret || typeof candidate !== 'string' || !tokenPattern.test(candidate) ||
			!timingSafeEqual(Buffer.from(candidate), Buffer.from(deriveCsrfToken(secret)))) {
			return reject(request, reply, 403, 'CSRF_REJECTED', 'Refresh the page and try again.');
		}
	}

	app.addHook('onRequest', async (request, reply) => {
		if (!request.routeOptions.url || request.routeOptions.config.publicAccess) {
			return;
		}

		reply.header('Cache-Control', 'no-store');
		await loadSession(request);
		if (!request.accountSession) {
			return requireAccount(request, reply);
		}

		if (request.method !== 'GET' && request.method !== 'HEAD') {
			return rejectWrongOrigin(request, reply) ??
				rejectWrongCsrf(request, reply, request.accountSession.token);
		}
	});

	function respondWithSession(reply: FastifyReply, session: AccountSession): AuthSessionResponse {
		reply
			.setCookie(sessionCookie, session.token, { ...cookieOptions, maxAge: sessionMaxAge })
			.clearCookie(preAuthCookie, cookieOptions);
		return { account: session.account, csrfToken: deriveCsrfToken(session.token) };
	}

	app.get(authSessionPath, {
		config: { publicAccess: true },
		schema: {
			operationId: 'getSession',
			response: { 200: AuthSessionResponse, 500: ApiErrorResponse },
		},
	}, async (request, reply): Promise<AuthSessionResponse> => {
		reply.header('Cache-Control', 'no-store');
		await loadSession(request);
		if (request.accountSession) {
			return { account: request.accountSession.account, csrfToken: deriveCsrfToken(request.accountSession.token) };
		}

		const existing = tokenCookie(request, preAuthCookie);
		const secret = existing ?? randomToken();
		if (!existing) {
			reply.setCookie(preAuthCookie, secret, { ...cookieOptions, maxAge: 30 * 60 });
		}
		return { account: null, csrfToken: deriveCsrfToken(secret) };
	});

	app.post<{ Body: LoginBody }>(authLoginPath, {
		config: { publicAccess: true },
		bodyLimit: 8_192,
		schema: {
			operationId: 'login',
			body: LoginBody,
			response: { 200: AuthSessionResponse, 400: ApiErrorResponse, 401: ApiErrorResponse, 403: ApiErrorResponse, 429: ApiErrorResponse, 500: ApiErrorResponse },
		},
		onRequest: async (request, reply) => {
			reply.header('Cache-Control', 'no-store');
			const denied = rejectWrongOrigin(request, reply);
			if (denied) {
				return denied;
			}
			await loadSession(request);
			return rejectWrongCsrf(request, reply, request.accountSession?.token ?? tokenCookie(request, preAuthCookie));
		},
	}, async (request, reply) => {
		const release = limits.reservePasswordWork();
		if (!release) {
			return rateLimited(request, reply, 1);
		}
		try {
			const email = normalizeEmail(request.body.email);
			const retryAfter = limits.verificationRetryAfter('login', email, canonicalAddress(request.ip));
			if (retryAfter > 0) {
				return rateLimited(request, reply, retryAfter);
			}
			const session = await store.login(email, request.body.password, request.accountSession?.token);
			if (!session) {
				return reject(request, reply, 401, 'INVALID_CREDENTIALS', 'Check the email and password and try again.');
			}
			return respondWithSession(reply, session);
		} finally {
			release();
		}
	});

	app.post(authLogoutPath, {
		schema: {
			operationId: 'logout',
			response: { 204: Type.Null(), 401: ApiErrorResponse, 403: ApiErrorResponse, 500: ApiErrorResponse },
		},
	}, async (request, reply) => {
		await store.logout(request.accountSession!);
		return reply.clearCookie(sessionCookie, cookieOptions).code(204).send();
	});

	app.post<{ Body: ChangePasswordBody }>(authPasswordPath, {
		bodyLimit: 8_192,
		schema: {
			operationId: 'changePassword',
			body: ChangePasswordBody,
			response: { 200: AuthSessionResponse, 400: ApiErrorResponse, 401: ApiErrorResponse, 403: ApiErrorResponse, 422: ApiErrorResponse, 429: ApiErrorResponse, 500: ApiErrorResponse },
		},
	}, async (request, reply) => {
		const { currentPassword, newPassword } = request.body;
		if (!validNewPassword(newPassword)) {
			return reject(request, reply, 422, 'INVALID_PASSWORD', passwordLengthMessage);
		}

		const release = limits.reservePasswordWork();
		if (!release) {
			return rateLimited(request, reply, 1, 'PASSWORD_RATE_LIMITED');
		}

		try {
			const session = request.accountSession!;
			const retryAfter = limits.verificationRetryAfter('password', session.account.email, canonicalAddress(request.ip));
			if (retryAfter > 0) {
				return rateLimited(request, reply, retryAfter, 'PASSWORD_RATE_LIMITED');
			}
			const result = await store.changePassword(session, currentPassword, newPassword);
			switch (result.status) {
				case 'invalid-current-password':
					return reject(request, reply, 422, 'INVALID_CURRENT_PASSWORD', 'The current password is incorrect.');
				case 'session-ended':
					return requireAccount(request, reply);
				case 'changed':
					return respondWithSession(reply, result.session);
			}
		} finally {
			release();
		}
	});

	app.get(accountPath, {
		schema: {
			operationId: 'getAccount',
			response: { 200: AccountResponse, 401: ApiErrorResponse, 500: ApiErrorResponse },
		},
	}, async (request) => request.accountSession!.account);
}
