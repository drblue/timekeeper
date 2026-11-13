import {
	ApiErrorResponse,
	idempotencyKeyHeader,
	StartTimerBody,
	StopTimerBody,
	StopTimerResponse,
	TimerIdempotencyHeaders,
	timerPath,
	timerStartPath,
	TimerStateResponse,
	timerStopPath,
} from '@timekeeper/contracts';
import type { FastifyInstance } from 'fastify';
import type { TimerStore } from './store.ts';

const mutationErrors = { 400: ApiErrorResponse, 401: ApiErrorResponse, 403: ApiErrorResponse,
	409: ApiErrorResponse, 413: ApiErrorResponse, 422: ApiErrorResponse, 500: ApiErrorResponse };

export function registerTimer(app: FastifyInstance, store: TimerStore) {
	app.get(timerPath, {
		schema: { operationId: 'getTimer', response: { 200: TimerStateResponse, 401: ApiErrorResponse, 500: ApiErrorResponse } },
	}, (request) => store.getState(request.accountSession!.accountId));

	app.post<{ Body: StartTimerBody; Headers: TimerIdempotencyHeaders }>(timerStartPath, {
		bodyLimit: 32_768,
		schema: {
			operationId: 'startTimer', body: StartTimerBody, headers: TimerIdempotencyHeaders,
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
}
