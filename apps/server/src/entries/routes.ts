import {
	ApiErrorResponse,
	CreateEntryBody,
	EntryListResponse,
	EntryResponse,
	entriesPath,
	EntryIdParams,
	EntryListQuery,
} from '@timekeeper/contracts';
import type { FastifyInstance } from 'fastify';
import type { EntryStore } from './store.ts';

const readErrors = { 400: ApiErrorResponse, 401: ApiErrorResponse, 500: ApiErrorResponse };

export function registerEntries(app: FastifyInstance, store: EntryStore) {
	app.get(entriesPath, {
		schema: {
			operationId: 'listEntries',
			querystring: EntryListQuery,
			response: { 200: EntryListResponse, ...readErrors },
		},
	}, (request) => store.listEntries(request.accountSession!.accountId));

	app.get<{ Params: EntryIdParams }>(`${entriesPath}/:id`, {
		schema: {
			operationId: 'getEntry',
			params: EntryIdParams,
			querystring: EntryListQuery,
			response: { 200: EntryResponse, ...readErrors, 404: ApiErrorResponse },
		},
	}, (request) => store.getEntry(request.accountSession!.accountId, request.params.id));

	app.post<{ Body: CreateEntryBody }>(entriesPath, {
		bodyLimit: 32_768,
		schema: {
			operationId: 'createEntry',
			body: CreateEntryBody,
			response: { 201: EntryResponse, ...readErrors, 403: ApiErrorResponse, 409: ApiErrorResponse, 413: ApiErrorResponse, 422: ApiErrorResponse },
		},
	}, async (request, reply) => {
		const entry = await store.createEntry(request.accountSession!.accountId, request.body);
		return reply.code(201).send(entry);
	});
}
