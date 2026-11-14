import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import swagger from '@fastify/swagger';
import { TypeGuard } from '@sinclair/typebox';
import { TypeCompiler } from '@sinclair/typebox/compiler';
import { ApiErrorResponse, healthPath, HealthQuery, HealthResponse } from '@timekeeper/contracts';
import Fastify from 'fastify';
import type { FastifyError } from 'fastify';
import { ApiRequestError } from './api-error.ts';
import { canonicalAddress } from './auth/config.ts';
import { registerAccountAccess } from './auth/routes.ts';
import type { AuthOptions } from './auth/routes.ts';
import { registerCatalog } from './catalog/routes.ts';
import type { CatalogStore } from './catalog/store.ts';
import { registerEntries } from './entries/routes.ts';
import type { EntryStore } from './entries/store.ts';
import { registerReports } from './reports/routes.ts';
import type { createReportPreview } from './reports/routes.ts';
import { registerTimer } from './timer/routes.ts';
import type { TimerStore } from './timer/store.ts';

interface AppOptions {
	webRoot?: string;
	logger?: boolean;
	auth?: AuthOptions;
	catalog?: CatalogStore;
	entries?: EntryStore;
	reportPreview?: ReturnType<typeof createReportPreview>;
	timer?: TimerStore;
}

export async function createApp({ webRoot, logger = false, auth, catalog, entries, timer, reportPreview }: AppOptions = {}) {
	if (webRoot) {
		await access(resolve(webRoot, 'index.html'));
	}

	const app = Fastify({
		logger: logger ? {
			serializers: { req: (request) => ({ method: request.method }) },
			redact: { paths: ['req.headers', 'req.body', 'res.headers'], remove: true },
		} : false,
		requestIdHeader: false,
		genReqId: () => randomUUID(),
		trustProxy: (address, hop) => hop === 0 &&
			(auth?.config.trustedProxyAddresses.has(canonicalAddress(address)) ?? false),
		frameworkErrors(error, request, reply) {
			reply.server.errorHandler(error, request, reply);
		},
		ajv: {
			customOptions: {
				coerceTypes: false,
				removeAdditional: false,
			},
		},
	});

	app.setSerializerCompiler(({ schema }) => {
		if (!TypeGuard.IsSchema(schema)) {
			throw new Error('Response schemas must use TypeBox');
		}

		const validator = TypeCompiler.Compile(schema);

		return (value: unknown) => {
			if (!validator.Check(value)) {
				throw new Error('Response did not match its schema');
			}

			return JSON.stringify(value);
		};
	});

	app.setErrorHandler((error, request, reply) => {
		reply.header('Cache-Control', 'no-store');
		const requestId = request.id;
		if (error instanceof ApiRequestError) {
			return reply.code(error.status).send({
				code: error.code,
				message: error.message,
				requestId,
				...(error.field ? { fieldErrors: [{ field: `body/${error.field}`, message: error.message }] } : {}),
			} satisfies ApiErrorResponse);
		}
		const details = error instanceof Error ? error as Partial<FastifyError> : {};

		if (details.validation) {
			const body: ApiErrorResponse = {
				code: 'INVALID_REQUEST',
				message: 'The request does not match the API contract.',
				requestId,
				fieldErrors: details.validation.map((issue) => ({
					field: `${details.validationContext}${issue.instancePath}`,
					message: 'Invalid value or unsupported field.',
				})),
			};

			return reply.code(400).send(body);
		}

		const statusCode = details.statusCode ?? 500;

		if (statusCode >= 400 && statusCode < 500) {
			const body: ApiErrorResponse = {
				code: 'REQUEST_REJECTED',
				message: 'The server rejected the request.',
				requestId,
			};

			return reply.code(statusCode).send(body);
		}

		request.log.error({ code: details.code }, 'Request failed');

		const body: ApiErrorResponse = {
			code: 'INTERNAL_ERROR',
			message: 'The server could not complete the request.',
			requestId,
		};

		return reply.code(500).send(body);
	});

	app.setNotFoundHandler((request, reply) => {
		const body: ApiErrorResponse = {
			code: 'NOT_FOUND',
			message: 'No route matches the request.',
			requestId: request.id,
		};

		return reply.code(404).header('Cache-Control', 'no-store').send(body);
	});

	await app.register(swagger, {
		openapi: {
			openapi: '3.1.0',
			info: {
				title: 'Timekeeper API',
				version: '1.0.0',
			},
		},
	});

	await registerAccountAccess(app, auth);
	if (catalog) {
		registerCatalog(app, catalog);
	}
	if (entries) {
		registerEntries(app, entries);
	}
	if (reportPreview) {
		registerReports(app, reportPreview);
	}
	if (timer) {
		registerTimer(app, timer);
	}

	app.get<{ Reply: HealthResponse | ApiErrorResponse }>(healthPath, {
		config: { publicAccess: true },
		schema: {
			operationId: 'getLiveness',
			summary: 'Check API process liveness',
			description: 'Reports whether the API process can serve requests. The endpoint accepts no query parameters.',
			querystring: HealthQuery,
			response: {
				200: { ...HealthResponse, description: 'The API is responding.' },
				400: { ...ApiErrorResponse, description: 'The query contains unsupported fields.' },
				500: { ...ApiErrorResponse, description: 'The API could not respond to the check.' },
			},
		},
	}, async (_request, reply) => {
		reply.header('Cache-Control', 'no-store');
		return { status: 'ok' };
	});

	app.get('/api/v1/openapi.json', { config: { publicAccess: true }, schema: { hide: true } }, async (_request, reply) => {
		reply.header('Cache-Control', 'no-cache');
		return app.swagger();
	});

	if (webRoot) {
		await app.register(async (web) => {
			web.addHook('onRoute', (route) => {
				route.config = { ...route.config, publicAccess: true };
			});

			await web.register(fastifyStatic, {
				root: resolve(webRoot, 'assets'),
				prefix: '/assets/',
				dotfiles: 'ignore',
				index: false,
				maxAge: '1y',
				immutable: true,
			});

			for (const path of ['/', '/login', '/password', '/clients', '/projects', '/entries', '/entries/trash', '/entries/:entryId', '/reports/preview']) {
				web.get(path, { schema: { hide: true } }, (_request, reply) => {
					return reply.header('Cache-Control', 'no-cache').sendFile('index.html', webRoot, { cacheControl: false });
				});
			}
		});
	}

	return app;
}
