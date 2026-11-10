import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
	accountPath,
	authLoginPath,
	authLogoutPath,
	authPasswordPath,
	authSessionPath,
	csrfHeader,
	parseAuthSessionResponse,
} from '@timekeeper/contracts';
import type { InjectOptions, LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.ts';
import { readAuthConfig } from '../src/auth/config.ts';
import { openDatabase } from '../src/auth/database.ts';
import * as passwords from '../src/auth/passwords.ts';
import { createAuthStore, provisionAccount, resetAccount, sessionMaxAge } from '../src/auth/store.ts';

const email = 'operator@example.test';
const password = 'initial test password';
const newPassword = 'replacement test password';
const resetPassword = 'recovery test password';
const origin = 'https://timekeeper.example.test';
const sessionCookie = '__Host-timekeeper-session';
const csrfCookie = '__Host-timekeeper-csrf';

describe('Account access', () => {
	let fixtureDirectory: string;
	let fixtureFile: string;
	let directory: string;
	let databaseUrl: string;
	let database: Awaited<ReturnType<typeof openDatabase>>;
	let app: Awaited<ReturnType<typeof createApp>>;

	beforeAll(async () => {
		fixtureDirectory = await mkdtemp(join(tmpdir(), 'timekeeper-auth-migration-'));
		fixtureFile = join(fixtureDirectory, 'test.sqlite');
		execFileSync('npm', ['run', 'db:migrate'], {
			env: { ...process.env, TIMEKEEPER_DATABASE_URL: pathToFileURL(fixtureFile).href },
			stdio: 'pipe',
		});
	});

	afterAll(async () => {
		await rm(fixtureDirectory, { recursive: true, force: true });
	});

	async function start(trustedProxyAddresses: string[] = []) {
		const store = await createAuthStore(database);
		app = await createApp({ auth: { config: { origin, trustedProxyAddresses: new Set(trustedProxyAddresses) }, store } });
	}

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), 'timekeeper-auth-test-'));
		const filename = join(directory, 'test.sqlite');
		await copyFile(fixtureFile, filename);
		databaseUrl = pathToFileURL(filename).href;
		database = await openDatabase(databaseUrl);
		expect(await provisionAccount(database, email, password)).toBe(true);
		await start();
	});

	afterEach(async () => {
		await app?.close();
		await database?.$disconnect();
		await rm(directory, { recursive: true, force: true });
	});

	function cookie(response: LightMyRequestResponse, name: string): string {
		const value = response.cookies.find((entry) => entry.name === name)?.value;
		expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
		return value!;
	}

	async function startBrowser() {
		const response = await app.inject({ method: 'GET', url: authSessionPath });
		expect(response.statusCode).toBe(200);
		expect(response.headers['cache-control']).toBe('no-store');
		const session = parseAuthSessionResponse(response.json());
		expect(session.account).toBeNull();
		expect(response.cookies).toContainEqual(expect.objectContaining({
			name: csrfCookie, maxAge: 1800, secure: true, httpOnly: true, sameSite: 'Strict', path: '/',
		}));
		return {
			cookies: { [csrfCookie]: cookie(response, csrfCookie) },
			headers: { origin, [csrfHeader]: session.csrfToken },
		};
	}

	function login(browser: Pick<InjectOptions, 'cookies' | 'headers'>, overrides: InjectOptions = {}) {
		return app.inject({ ...browser, method: 'POST', url: authLoginPath, payload: { email, password }, ...overrides });
	}

	function loggedIn(response: LightMyRequestResponse) {
		expect(response.statusCode).toBe(200);
		expect(response.headers['cache-control']).toBe('no-store');
		const token = cookie(response, sessionCookie);
		const session = parseAuthSessionResponse(response.json());
		expect(session.account).toEqual({ email });
		return {
			cookies: { [sessionCookie]: token },
			headers: { origin, [csrfHeader]: session.csrfToken },
		};
	}

	async function access(cookies?: Record<string, string>) {
		return app.inject({ method: 'GET', url: accountPath, cookies });
	}

	it('keeps private data behind the session, persists only a token digest, and revokes it on logout', async () => {
		expect((await access()).json()).toMatchObject({ code: 'AUTH_REQUIRED' });

		const response = await login(await startBrowser(), { payload: { email: '  OPERATOR@EXAMPLE.TEST ', password } });
		const current = loggedIn(response);
		expect(response.cookies).toContainEqual(expect.objectContaining({
			name: sessionCookie, maxAge: sessionMaxAge, secure: true, httpOnly: true, sameSite: 'Strict', path: '/',
		}));
		expect(response.cookies.find((entry) => entry.name === sessionCookie)?.domain).toBeUndefined();
		const token = current.cookies[sessionCookie]!;
		const [row] = await database.session.findMany();
		expect(row?.accountId).toMatch(/^[0-9a-f-]{36}$/);
		expect(row?.tokenHash).toBe(createHash('sha256').update(token).digest('hex'));
		expect(response.body).not.toContain(token);
		expect((await access(current.cookies)).json()).toEqual({ email });

		await app.close();
		await database.$disconnect();
		database = await openDatabase(databaseUrl);
		await start();
		expect((await access(current.cookies)).statusCode).toBe(200);

		const logout = await app.inject({ method: 'POST', url: authLogoutPath, ...current });
		expect(logout.statusCode).toBe(204);
		expect(logout.headers['set-cookie']).toContain('Max-Age=0');
		expect((await access(current.cookies)).statusCode).toBe(401);
		expect(await database.session.count()).toBe(0);
	});

	it('checks the exact origin and CSRF token before login and protected mutations', async () => {
		const browser = await startBrowser();
		expect((await login(browser, { headers: { ...browser.headers, origin: 'https://attacker.test' } })).json())
			.toMatchObject({ code: 'ORIGIN_REJECTED' });
		expect((await login(browser, { headers: { [csrfHeader]: browser.headers[csrfHeader] } })).json())
			.toMatchObject({ code: 'ORIGIN_REJECTED' });
		expect((await login(browser, { headers: { origin } })).json()).toMatchObject({ code: 'CSRF_REJECTED' });
		expect((await login(browser, { cookies: {} })).json()).toMatchObject({ code: 'CSRF_REJECTED' });
		expect((await login(browser, { payload: { email, password: [password] } })).json())
			.toMatchObject({ code: 'INVALID_REQUEST' });
		expect(await database.session.count()).toBe(0);

		const current = loggedIn(await login(browser));
		const wrongOrigin = await app.inject({
			method: 'POST', url: authLogoutPath, ...current,
			headers: { ...current.headers, origin: 'https://attacker.test' },
		});
		expect(wrongOrigin.json()).toMatchObject({ code: 'ORIGIN_REJECTED' });
		const wrongToken = await app.inject({
			method: 'POST', url: authPasswordPath, ...current,
			headers: { origin, [csrfHeader]: browser.headers[csrfHeader] },
			payload: { currentPassword: password, newPassword },
		});
		expect(wrongToken.json()).toMatchObject({ code: 'CSRF_REJECTED' });
		expect((await access(current.cookies)).statusCode).toBe(200);
	});

	it('rotates a live login and rejects an expired session even if its cookie remains', async () => {
		const first = loggedIn(await login(await startBrowser()));
		const second = loggedIn(await login(first));
		expect(second.cookies).not.toEqual(first.cookies);
		expect(second.headers[csrfHeader]).not.toBe(first.headers[csrfHeader]);
		expect((await access(first.cookies)).statusCode).toBe(401);
		expect((await access(second.cookies)).statusCode).toBe(200);

		await database.session.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
		expect((await access(second.cookies)).statusCode).toBe(401);
		const expired = await app.inject({ url: authSessionPath, cookies: second.cookies });
		expect(expired.json()).toMatchObject({ account: null });
	});

	it('validates the current password, replaces it, and revokes other sessions', async () => {
		const first = loggedIn(await login(await startBrowser()));
		const second = loggedIn(await login(await startBrowser()));

		const wrongPassword = await app.inject({
			method: 'POST', url: authPasswordPath, ...first,
			payload: { currentPassword: 'wrong password', newPassword },
		});
		expect(wrongPassword.json()).toMatchObject({ code: 'INVALID_CURRENT_PASSWORD' });
		const shortPassword = await app.inject({
			method: 'POST', url: authPasswordPath, ...first, payload: { currentPassword: password, newPassword: 'short' },
		});
		expect(shortPassword.json()).toMatchObject({ code: 'INVALID_PASSWORD' });
		expect((await access(second.cookies)).statusCode).toBe(200);

		const replacement = loggedIn(await app.inject({
			method: 'POST', url: authPasswordPath, ...first, payload: { currentPassword: password, newPassword },
		}));
		expect((await access(first.cookies)).statusCode).toBe(401);
		expect((await access(second.cookies)).statusCode).toBe(401);
		expect((await access(replacement.cookies)).statusCode).toBe(200);
		expect(await database.session.count()).toBe(1);
		expect((await login(await startBrowser())).json()).toMatchObject({ code: 'INVALID_CREDENTIALS' });
		loggedIn(await login(await startBrowser(), { payload: { email, password: newPassword } }));
	});

	it('throttles repeated current-password guesses even from multiple addresses', async () => {
		const session = loggedIn(await login(await startBrowser()));
		const submit = (attempt: number, currentPassword: string) => app.inject({
			method: 'POST', url: authPasswordPath, ...session,
			remoteAddress: `198.51.100.${attempt}`,
			payload: { currentPassword, newPassword },
		});
		for (let attempt = 1; attempt <= 5; attempt++) {
			expect((await submit(attempt, 'wrong password')).json()).toMatchObject({ code: 'INVALID_CURRENT_PASSWORD' });
		}
		const blocked = await submit(6, password);
		expect(blocked.statusCode).toBe(429);
		expect(blocked.json()).toMatchObject({ code: 'PASSWORD_RATE_LIMITED' });
		expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
		expect((await access(session.cookies)).statusCode).toBe(200);
	});

	it('limits the normalized account across client addresses and ignores spoofed forwarding from direct peers', async () => {
		const browser = await startBrowser();
		for (let attempt = 0; attempt < 5; attempt++) {
			const response = await login(browser, {
				remoteAddress: `198.51.100.${attempt + 1}`,
				payload: { email: attempt % 2 === 0 ? 'OPERATOR@example.test' : ' operator@example.test ', password: 'wrong' },
			});
			expect(response.json()).toMatchObject({ code: 'INVALID_CREDENTIALS' });
		}
		const locked = await login(browser, { remoteAddress: '198.51.100.50' });
		expect(locked.statusCode).toBe(429);
		expect(locked.json()).toMatchObject({ code: 'LOGIN_RATE_LIMITED' });
		expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);

		for (let attempt = 0; attempt < 20; attempt++) {
			const response = await login(browser, {
				remoteAddress: '198.51.100.60',
				headers: { ...browser.headers, 'x-forwarded-for': `203.0.113.${attempt + 1}` },
				payload: { email: `unknown-${attempt}@example.test`, password: 'wrong' },
			});
			expect(response.json()).toMatchObject({ code: 'INVALID_CREDENTIALS' });
		}
		const blocked = await login(browser, {
			remoteAddress: '198.51.100.60',
			headers: { ...browser.headers, 'x-forwarded-for': '203.0.113.99' },
			payload: { email: 'another@example.test', password: 'wrong' },
		});
		expect(blocked.statusCode).toBe(429);
	});

	it('uses the nearest forwarded address only from a configured immediate proxy', async () => {
		await app.close();
		await start(['192.0.2.5']);
		const browser = await startBrowser();
		for (let attempt = 0; attempt < 20; attempt++) {
			const response = await login(browser, {
				remoteAddress: '192.0.2.5',
				headers: { ...browser.headers, 'x-forwarded-for': `203.0.113.${attempt + 1}, 198.51.100.7` },
				payload: { email: `unknown-${attempt}@example.test`, password: 'wrong' },
			});
			expect(response.statusCode).toBe(401);
		}

		const proxyLogin = (client: string) => login(browser, {
			remoteAddress: '192.0.2.5',
			headers: { ...browser.headers, 'x-forwarded-for': client },
		});
		expect((await proxyLogin('198.51.100.7')).statusCode).toBe(429);
		loggedIn(await proxyLogin('198.51.100.8'));
	});

	it('preserves the original account and atomically revokes sessions on local reset', async () => {
		const first = loggedIn(await login(await startBrowser()));
		const second = loggedIn(await login(await startBrowser()));
		expect(await provisionAccount(database, 'second@example.test', resetPassword)).toBe(false);
		expect(await database.account.count()).toBe(1);
		const operatorDatabase = await openDatabase(databaseUrl);
		try {
			expect(await resetAccount(operatorDatabase, resetPassword)).toBe(true);
		} finally {
			await operatorDatabase.$disconnect();
		}
		expect((await access(first.cookies)).statusCode).toBe(401);
		expect((await access(second.cookies)).statusCode).toBe(401);
		expect((await login(await startBrowser())).json()).toMatchObject({ code: 'INVALID_CREDENTIALS' });
		loggedIn(await login(await startBrowser(), { payload: { email, password: resetPassword } }));
	});

	it('rejects a login that verified the old password before a concurrent reset committed', async () => {
		const browser = await startBrowser();
		let verified = false;
		let resumeVerification: () => void = () => {};
		const verificationPaused = new Promise<void>((resolve) => {
			resumeVerification = resolve;
		});
		const verify = passwords.verifyPassword;
		const pauseAfterVerify = vi.spyOn(passwords, 'verifyPassword').mockImplementation(async (hash, candidate) => {
			const matches = await verify(hash, candidate);
			verified = true;
			await verificationPaused;
			return matches;
		});
		const pendingLogin = login(browser);
		try {
			await vi.waitFor(() => expect(verified).toBe(true));
			expect(await resetAccount(database, resetPassword)).toBe(true);
		} finally {
			resumeVerification();
			pauseAfterVerify.mockRestore();
		}
		expect((await pendingLogin).json()).toMatchObject({ code: 'INVALID_CREDENTIALS' });
		expect(await database.session.count()).toBe(0);
	});
});

describe('Account access configuration', () => {
	it('allows plain HTTP only for a loopback development listener and origin', () => {
		const local = 'http://127.0.0.1:3000';
		expect(readAuthConfig({}, '127.0.0.1', local).origin).toBe(local);
		expect(() => readAuthConfig({ NODE_ENV: 'production' }, '127.0.0.1', local)).toThrow(/TIMEKEEPER_ORIGIN/);
		expect(() => readAuthConfig({ NODE_ENV: 'production', TIMEKEEPER_ORIGIN: local }, '127.0.0.1', local)).toThrow(/HTTPS/);
		expect(() => readAuthConfig({}, '0.0.0.0', local)).toThrow(/HTTPS/);
		expect(() => readAuthConfig({ TIMEKEEPER_ORIGIN: 'http://192.0.2.15' }, '127.0.0.1', local)).toThrow(/HTTPS/);
	});

	it('accepts only a canonical HTTPS origin and explicit literal proxy peers', () => {
		const environment = { NODE_ENV: 'production', TIMEKEEPER_ORIGIN: origin };
		expect(readAuthConfig({
			...environment, TIMEKEEPER_TRUSTED_PROXY_IPS: '::ffff:127.0.0.1, 2001:0db8::5',
		}, '127.0.0.1', origin).trustedProxyAddresses).toEqual(new Set(['127.0.0.1', '2001:db8::5']));
		expect(() => readAuthConfig({ ...environment, TIMEKEEPER_ORIGIN: `${origin}/login` }, '127.0.0.1', origin)).toThrow(/origin/i);
		expect(() => readAuthConfig({ ...environment, TIMEKEEPER_TRUSTED_PROXY_IPS: '0.0.0.0/0' }, '127.0.0.1', origin))
			.toThrow(/literal proxy IP/);
	});
});
