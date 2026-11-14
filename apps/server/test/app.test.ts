import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiErrorResponse, healthPath, HealthResponse, readinessPath } from '@timekeeper/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';

describe('Timekeeper API', () => {
	let app: Awaited<ReturnType<typeof createApp>>;

	beforeEach(async () => {
		app = await createApp();
	});

	afterEach(async () => {
		await app.close();
	});

	it('returns only process liveness and forbids caching', async () => {
		const response = await app.inject({ method: 'GET', url: healthPath });

		expect(response.statusCode).toBe(200);
		expect(response.headers['content-type']).toMatch(/^application\/json/);
		expect(response.headers['cache-control']).toBe('no-store');
		expect(response.json()).toEqual({ status: 'ok' });
	});

	it('keeps readiness separate from liveness and discloses no probe error details', async () => {
		let healthy = true;
		const tested = await createApp({ readiness: async () => {
			if (!healthy) throw new Error('private database path');
		} });
		try {
			const ready = await tested.inject({ url: readinessPath });
			expect(ready.statusCode).toBe(200);
			expect(ready.json()).toEqual({ status: 'ready' });
			expect(ready.headers['cache-control']).toBe('no-store');
			expect((await tested.inject({ url: readinessPath + '?unexpected=true' })).statusCode).toBe(400);

			healthy = false;
			const unavailable = await tested.inject({ url: readinessPath });
			expect(unavailable.statusCode).toBe(503);
			expect(unavailable.json()).toEqual({ status: 'not-ready' });
			expect(unavailable.headers['cache-control']).toBe('no-store');
			expect(unavailable.body).not.toContain('private database path');
			expect((await tested.inject({ url: healthPath })).statusCode).toBe(200);
		} finally {
			await tested.close();
		}
	});

	it('rejects unsupported query parameters with a structured error', async () => {
		const response = await app.inject({
			method: 'GET',
			url: `${healthPath}?unexpected=private-data`,
			headers: { 'request-id': 'supplied-by-client' },
		});

		expect(response.statusCode).toBe(400);
		expect(response.headers['cache-control']).toBe('no-store');
		expect(response.json()).toEqual({
			code: 'INVALID_REQUEST',
			message: 'The request does not match the API contract.',
			requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
			fieldErrors: [{ field: 'querystring', message: 'Invalid value or unsupported field.' }],
		});
		expect(response.body).not.toContain('private-data');
	});

	it('rejects an invalid response before serializing its contents', async () => {
		app.get('/api/v1/broken', {
			config: { publicAccess: true },
			schema: {
				response: { 200: HealthResponse, 500: ApiErrorResponse },
			},
		}, async () => ({ status: 'ok', privateData: 'do not disclose' }));

		const response = await app.inject({ method: 'GET', url: '/api/v1/broken' });

		expect(response.statusCode).toBe(500);
		expect(response.json()).toEqual({
			code: 'INTERNAL_ERROR',
			message: 'The server could not complete the request.',
			requestId: expect.any(String),
		});
		expect(response.body).not.toContain('do not disclose');
	});

	it('denies newly registered routes unless they explicitly allow public access', async () => {
		app.get('/api/v1/private', async () => ({ privateData: 'do not disclose' }));

		const response = await app.inject({ method: 'GET', url: '/api/v1/private' });

		expect(response.statusCode).toBe(401);
		expect(response.headers['cache-control']).toBe('no-store');
		expect(response.json()).toMatchObject({ code: 'AUTH_REQUIRED' });
		expect(response.body).not.toContain('do not disclose');
	});

	it('rejects a malformed API path with a structured error', async () => {
		const response = await app.inject({
			method: 'GET',
			url: '/api/v1/%private-data',
			headers: { 'request-id': 'supplied-by-client' },
		});

		expect(response.statusCode).toBe(400);
		expect(response.headers['content-type']).toMatch(/^application\/json/);
		expect(response.headers['cache-control']).toBe('no-store');
		expect(response.json()).toEqual({
			code: 'REQUEST_REJECTED',
			message: 'The server rejected the request.',
			requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
		});
	});

	it('publishes the response and error schemas from the liveness route', async () => {
		const response = await app.inject({ method: 'GET', url: '/api/v1/openapi.json' });

		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({
			openapi: '3.1.0',
			paths: {
				[healthPath]: {
					get: {
						operationId: 'getLiveness',
						responses: {
							200: {
								content: {
									'application/json': {
										schema: {
										properties: { status: { enum: ['ok'] } },
											required: ['status'],
											additionalProperties: false,
										},
									},
								},
							},
							400: {
								content: {
									'application/json': {
										schema: { required: ['code', 'message', 'requestId'] },
									},
								},
							},
							500: expect.any(Object),
						},
					},
				},
			},
		});
	});

	it('returns JSON for an unknown API path even when the client accepts HTML', async () => {
		const response = await app.inject({
			method: 'GET',
			url: '/api/v1/unknown',
			headers: { accept: 'text/html' },
		});

		expect(response.statusCode).toBe(404);
		expect(response.headers['content-type']).toMatch(/^application\/json/);
		expect(response.json()).toEqual({
			code: 'NOT_FOUND',
			message: 'No route matches the request.',
			requestId: expect.any(String),
		});
	});
});


describe('Browser installation assets', () => {
	it('serves only the allowed installation files publicly and keeps app and API caching separate', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'timekeeper-pwa-test-'));
		let app: Awaited<ReturnType<typeof createApp>> | undefined;
		const manifest = JSON.stringify({ name: 'Timekeeper', display: 'standalone' });
		const icons = ['timekeeper-192.png', 'timekeeper-512.png', 'timekeeper-maskable-512.png', 'apple-touch-icon.png'];
		try {
			await Promise.all([
				mkdir(join(directory, 'assets')),
				mkdir(join(directory, 'icons')),
				writeFile(join(directory, 'index.html'), '<!doctype html><title>Timekeeper</title>'),
				writeFile(join(directory, 'manifest.webmanifest'), manifest),
			]);
			await Promise.all([
				writeFile(join(directory, 'assets', 'app-123.js'), 'export {};'),
				writeFile(join(directory, 'icons', 'private.png'), 'unlisted data'),
				...icons.map((file) => writeFile(join(directory, 'icons', file), 'icon data')),
			]);
			app = await createApp({ webRoot: directory });
			app.get('/api/v1/pwa-private-test', async () => ({ privateData: 'private data' }));

			const install = await app.inject({ url: '/manifest.webmanifest' });
			expect(install.statusCode).toBe(200);
			expect(install.body).toBe(manifest);
			expect(install.headers).toMatchObject({
				'content-type': 'application/manifest+json', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff',
			});
			for (const file of icons) {
				const icon = await app.inject({ url: '/icons/' + file });
				expect(icon.statusCode).toBe(200);
				expect(icon.body).toBe('icon data');
				expect(icon.headers).toMatchObject({
					'content-type': 'image/png', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff',
				});
			}
			const shell = await app.inject({ url: '/' });
			expect(shell.statusCode).toBe(200);
			expect(shell.headers['cache-control']).toBe('no-cache');
			const asset = await app.inject({ url: '/assets/app-123.js' });
			expect(asset.statusCode).toBe(200);
			expect(asset.headers['cache-control']).toContain('immutable');
			for (const url of ['/icons/private.png', '/sw.js', '/service-worker.js']) {
				expect((await app.inject({ url })).statusCode).toBe(404);
			}
			const privateApi = await app.inject({ url: '/api/v1/pwa-private-test' });
			expect(privateApi.statusCode).toBe(401);
			expect(privateApi.headers['cache-control']).toBe('no-store');
			expect(privateApi.body).not.toContain('private data');
		} finally {
			await app?.close();
			await rm(directory, { recursive: true, force: true });
		}
	});
});
