import { ApiErrorResponse, ClockifyPreviewQuery, ClockifyPreviewResponse, clockifyPreviewPath, maxClockifyCsvBytes } from '@timekeeper/contracts';
import type { FastifyInstance } from 'fastify';
import { previewClockify } from './clockify-preview.ts';

export async function registerClockifyImport(app: FastifyInstance) {
	await app.register(async (clockify) => {
		clockify.addContentTypeParser('text/csv', { parseAs: 'buffer' }, (_request, bytes, done) => done(null, bytes));
		clockify.post<{ Body: Buffer; Querystring: ClockifyPreviewQuery }>(clockifyPreviewPath, {
			bodyLimit: maxClockifyCsvBytes,
			onRequest: async (request, reply) => {
				if (/^text\/csv(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) return;
				return reply.code(415).send({
					code: 'CLOCKIFY_UNSUPPORTED_MEDIA_TYPE', message: 'Upload the Clockify CSV as text/csv.', requestId: request.id,
				});
			},
			schema: {
				operationId: 'previewClockifyImport',
				querystring: ClockifyPreviewQuery,
				consumes: ['text/csv'],
				response: {
					200: ClockifyPreviewResponse, 400: ApiErrorResponse, 401: ApiErrorResponse, 403: ApiErrorResponse,
					413: ApiErrorResponse, 415: ApiErrorResponse, 422: ApiErrorResponse, 500: ApiErrorResponse,
				},
			},
		}, (request) => previewClockify(request.body ?? Buffer.alloc(0), request.query));
	});
}
