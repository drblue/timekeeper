import {
	ApiErrorResponse, ClockifyImportBatchListQuery, ClockifyImportBatchListResponse, ClockifyImportBatchParams,
	ClockifyUndoCommitBody, ClockifyUndoCommitResponse, ClockifyUndoPreviewResponse, clockifyBatchesPath, ClockifyImportCommitBody, ClockifyImportCommitResponse, ClockifyImportReviewBody, ClockifyImportReviewResponse,
	ClockifyCorrectionTargetsQuery, ClockifyCorrectionTargetsResponse, ClockifyPreviewQuery, ClockifyPreviewResponse, ClockifyStageResponse, TimerIdempotencyHeaders,
	clockifyCommitPath, clockifyCorrectionTargetsPath, clockifyPreviewPath, clockifyReviewPath, clockifyStagePath, idempotencyKeyHeader, maxClockifyCsvBytes,
} from '@timekeeper/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { previewClockify } from './clockify-preview.ts';
import { maxClockifyReviewBytes } from './clockify-store.ts';
import type { createClockifyImportStore } from './clockify-store.ts';

const errors = {
	400: ApiErrorResponse, 401: ApiErrorResponse, 403: ApiErrorResponse, 404: ApiErrorResponse, 409: ApiErrorResponse,
	413: ApiErrorResponse, 415: ApiErrorResponse, 422: ApiErrorResponse, 429: ApiErrorResponse, 500: ApiErrorResponse,
};

async function requireCsv(request: FastifyRequest, reply: FastifyReply) {
	if (/^text\/csv(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) return;
	return reply.code(415).send({
		code: 'CLOCKIFY_UNSUPPORTED_MEDIA_TYPE', message: 'Upload the Clockify CSV as text/csv.', requestId: request.id,
	});
}

const csvOptions = { bodyLimit: maxClockifyCsvBytes, onRequest: requireCsv };
const csvSchema = { querystring: ClockifyPreviewQuery, consumes: ['text/csv'] };

export async function registerClockifyImport(app: FastifyInstance, store?: ReturnType<typeof createClockifyImportStore>) {
	await app.register(async (clockify) => {
		clockify.addContentTypeParser('text/csv', { parseAs: 'buffer' }, (_request, bytes, done) => done(null, bytes));
		clockify.post<{ Body: Buffer; Querystring: ClockifyPreviewQuery }>(clockifyPreviewPath, {
			...csvOptions,
			schema: { ...csvSchema, operationId: 'previewClockifyImport', response: { 200: ClockifyPreviewResponse, ...errors } },
		}, (request) => previewClockify(request.body ?? Buffer.alloc(0), request.query));
		if (!store) return;

		clockify.post<{ Body: Buffer; Querystring: ClockifyPreviewQuery }>(clockifyStagePath, {
			...csvOptions,
			schema: { ...csvSchema, operationId: 'stageClockifyImport', response: { 200: ClockifyStageResponse, ...errors } },
		}, (request) => store.stage(request.accountSession!.accountId, request.body ?? Buffer.alloc(0), request.query));

		clockify.get<{ Querystring: ClockifyCorrectionTargetsQuery }>(clockifyCorrectionTargetsPath, {
			schema: { operationId: 'findClockifyCorrectionTargets', querystring: ClockifyCorrectionTargetsQuery,
				response: { 200: ClockifyCorrectionTargetsResponse, ...errors } },
		}, (request) => store.correctionTargets(request.accountSession!.accountId, request.query));

		clockify.get<{ Querystring: ClockifyImportBatchListQuery }>(clockifyBatchesPath, {
			schema: { operationId: 'listClockifyImportBatches', querystring: ClockifyImportBatchListQuery,
				response: { 200: ClockifyImportBatchListResponse, ...errors } },
		}, (request) => store.listBatches(request.accountSession!.accountId, request.query));

		clockify.get<{ Params: ClockifyImportBatchParams }>(`${clockifyBatchesPath}/:id/undo-preview`, {
			schema: { operationId: 'previewClockifyUndo', params: ClockifyImportBatchParams,
				response: { 200: ClockifyUndoPreviewResponse, ...errors } },
		}, (request) => store.previewUndo(request.accountSession!.accountId, request.params.id));

		clockify.post<{ Params: ClockifyImportBatchParams; Body: ClockifyUndoCommitBody; Headers: TimerIdempotencyHeaders }>(
			`${clockifyBatchesPath}/:id/undo`, {
				bodyLimit: 2_048,
				schema: { operationId: 'undoClockifyImport', params: ClockifyImportBatchParams, headers: TimerIdempotencyHeaders,
					body: ClockifyUndoCommitBody, response: { 200: ClockifyUndoCommitResponse, ...errors } },
			}, (request) => store.undo(request.accountSession!.accountId, request.params.id, request.body.previewHash,
				request.headers[idempotencyKeyHeader]),
		);

		clockify.post<{ Body: ClockifyImportReviewBody }>(clockifyReviewPath, {
			bodyLimit: maxClockifyReviewBytes,
			schema: {
				operationId: 'reviewClockifyMapping', body: ClockifyImportReviewBody, response: { 200: ClockifyImportReviewResponse, ...errors },
			},
		}, (request) => store.review(request.accountSession!.accountId, request.body));

		clockify.post<{ Body: ClockifyImportCommitBody; Headers: TimerIdempotencyHeaders }>(clockifyCommitPath, {
			bodyLimit: 2_048,
			schema: {
				operationId: 'commitClockifyImport', headers: TimerIdempotencyHeaders, body: ClockifyImportCommitBody,
				response: { 200: ClockifyImportCommitResponse, ...errors },
			},
		}, (request) => store.commit(request.accountSession!.accountId, request.headers[idempotencyKeyHeader], request.body.previewToken));
	});
}
