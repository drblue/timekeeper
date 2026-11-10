import { ApiErrorResponse, healthPath, HealthResponse } from '@timekeeper/contracts';
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
