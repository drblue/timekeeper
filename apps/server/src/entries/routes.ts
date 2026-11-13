import {
	ApiErrorResponse,
	CompleteEntryBody,
	CreateEntryBody,
	EntryEditBody,
	EntryEditPreview,
	EntryHistoryResponse,
	EntryListResponse,
	EntryResponse,
	entriesPath,
	EntryIdParams,
	EntryListQuery,
	EntryLifecycleBody,
	EntryTrashResponse,
	entryTrashPath,
	TimedEntryResponse,
	TrashedEntryResponse,
	WorkListQuery,
	WorkListResponse,
	workListPath,
} from '@timekeeper/contracts';
import type { FastifyInstance } from 'fastify';
import type { EntryStore } from './store.ts';

const readErrors = { 400: ApiErrorResponse, 401: ApiErrorResponse, 500: ApiErrorResponse };
const editErrors = { ...readErrors, 403: ApiErrorResponse, 404: ApiErrorResponse, 409: ApiErrorResponse, 413: ApiErrorResponse, 422: ApiErrorResponse };

export function registerEntries(app: FastifyInstance, store: EntryStore) {
	app.get(entryTrashPath, {
		schema: { operationId: 'listEntryTrash', querystring: EntryListQuery, response: { 200: EntryTrashResponse, ...readErrors } },
	}, (request) => store.listTrash(request.accountSession!.accountId));

	app.post<{ Params: EntryIdParams; Body: EntryLifecycleBody }>(`${entriesPath}/:id/delete`, {
		bodyLimit: 1_024,
		schema: {
			operationId: 'deleteEntry', params: EntryIdParams, body: EntryLifecycleBody,
			response: { 200: TrashedEntryResponse, ...editErrors },
		},
	}, (request) => store.deleteEntry(request.accountSession!.accountId, request.params.id, request.body.revision));

	app.post<{ Params: EntryIdParams; Body: EntryLifecycleBody }>(`${entriesPath}/:id/restore`, {
		bodyLimit: 1_024,
		schema: {
			operationId: 'restoreEntry', params: EntryIdParams, body: EntryLifecycleBody,
			response: { 200: EntryResponse, ...editErrors },
		},
	}, (request) => store.restoreEntry(request.accountSession!.accountId, request.params.id, request.body.revision));

	app.get<{ Querystring: WorkListQuery }>(workListPath, {
		schema: {
			operationId: 'listWork', querystring: WorkListQuery,
			response: { 200: WorkListResponse, ...readErrors, 422: ApiErrorResponse },
		},
	}, (request) => store.getWorkList(request.accountSession!.accountId, request.query));
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

	app.get<{ Params: EntryIdParams }>(`${entriesPath}/:id/history`, {
		schema: {
			operationId: 'getEntryHistory', params: EntryIdParams, querystring: EntryListQuery,
			response: { 200: EntryHistoryResponse, ...readErrors, 404: ApiErrorResponse },
		},
	}, (request) => store.getHistory(request.accountSession!.accountId, request.params.id));

	app.post<{ Params: EntryIdParams; Body: EntryEditBody }>(`${entriesPath}/:id/edit-preview`, {
		bodyLimit: 32_768,
		schema: {
			operationId: 'previewEntryEdit', params: EntryIdParams, body: EntryEditBody,
			response: { 200: EntryEditPreview, ...editErrors },
		},
	}, (request) => store.previewEdit(request.accountSession!.accountId, request.params.id, request.body));

	app.put<{ Params: EntryIdParams; Body: EntryEditBody }>(`${entriesPath}/:id`, {
		bodyLimit: 32_768,
		schema: {
			operationId: 'updateEntry', params: EntryIdParams, body: EntryEditBody,
			response: { 200: EntryResponse, ...editErrors },
		},
	}, (request) => store.updateEntry(request.accountSession!.accountId, request.params.id, request.body));

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

	app.post<{ Params: EntryIdParams; Body: CompleteEntryBody }>(`${entriesPath}/:id/complete`, {
		bodyLimit: 32_768,
		schema: {
			operationId: 'completeEntry', params: EntryIdParams, body: CompleteEntryBody,
			response: { 200: TimedEntryResponse, ...editErrors },
		},
	}, (request) => store.completeEntry(request.accountSession!.accountId, request.params.id, request.body));
}
