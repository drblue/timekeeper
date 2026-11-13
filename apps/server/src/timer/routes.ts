import {
	ApiErrorResponse,
	ContinueEntryPreview,
	entriesPath,
	EntryIdParams,
	EntryListQuery,
	idempotencyKeyHeader,
	StartTimerRequest,
	StopTimerBody,
	StopTimerResponse,
	SwitchTimerBody,
	SwitchTimerResponse,
	TimerIdempotencyHeaders,
	timerPath,
	timerStartPath,
	TimerStateResponse,
	timerStopPath,
	timerSwitchPath,
} from '@timekeeper/contracts';
import type { FastifyInstance } from 'fastify';
import type { TimerStore } from './store.ts';

const mutationErrors = { 400: ApiErrorResponse, 401: ApiErrorResponse, 403: ApiErrorResponse,
	404: ApiErrorResponse, 409: ApiErrorResponse, 413: ApiErrorResponse, 422: ApiErrorResponse, 500: ApiErrorResponse };

export function registerTimer(app: FastifyInstance, store: TimerStore) {
	app.get(timerPath, {
		schema: { operationId: 'getTimer', response: { 200: TimerStateResponse, 401: ApiErrorResponse, 500: ApiErrorResponse } },
	}, (request) => store.getState(request.accountSession!.accountId));

	app.get<{ Params: EntryIdParams }>(`${entriesPath}/:id/continue`, {
		schema: {
			operationId: 'previewContinuation', params: EntryIdParams, querystring: EntryListQuery,
			response: { 200: ContinueEntryPreview, 400: ApiErrorResponse, 401: ApiErrorResponse, 404: ApiErrorResponse, 422: ApiErrorResponse, 500: ApiErrorResponse },
		},
	}, (request) => store.previewContinuation(request.accountSession!.accountId, request.params.id));

	app.post<{ Body: StartTimerRequest; Headers: TimerIdempotencyHeaders }>(timerStartPath, {
		bodyLimit: 32_768,
		schema: {
			operationId: 'startTimer', body: StartTimerRequest, headers: TimerIdempotencyHeaders,
			response: { 201: TimerStateResponse, ...mutationErrors },
		},
	}, async (request, reply) => {
		const result = await store.start(request.accountSession!.accountId, request.headers[idempotencyKeyHeader], request.body);
		return reply.code(201).send(result);
	});

	app.post<{ Body: StopTimerBody; Headers: TimerIdempotencyHeaders }>(timerStopPath, {
		bodyLimit: 1_024,
		schema: {
			operationId: 'stopTimer', body: StopTimerBody, headers: TimerIdempotencyHeaders,
			response: { 200: StopTimerResponse, ...mutationErrors },
		},
	}, (request) => store.stop(request.accountSession!.accountId, request.headers[idempotencyKeyHeader], request.body));

	app.post<{ Body: SwitchTimerBody; Headers: TimerIdempotencyHeaders }>(timerSwitchPath, {
		bodyLimit: 32_768,
		schema: {
			operationId: 'switchTimer', body: SwitchTimerBody, headers: TimerIdempotencyHeaders,
			response: { 200: SwitchTimerResponse, ...mutationErrors },
		},
	}, (request) => store.switchTimer(request.accountSession!.accountId, request.headers[idempotencyKeyHeader], request.body));
}
