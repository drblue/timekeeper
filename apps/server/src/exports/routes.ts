import { Type } from '@sinclair/typebox';
import { ApiErrorResponse, EntriesCsvExportQuery, entriesCsvExportPath, portableExportPath } from '@timekeeper/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { workDateRange } from '../entries/work-scope.ts';
import type { PrismaClient } from '../generated/prisma/client.ts';
import { entriesCsv } from './entries-csv.ts';
import { portableArchive } from './portable.ts';
import { createExportSpool, exportCaptureTimeoutMs } from './spool.ts';

const errors = {
	400: ApiErrorResponse, 401: ApiErrorResponse, 422: ApiErrorResponse, 429: ApiErrorResponse, 500: ApiErrorResponse,
};
const snapshotOptions = { isolationLevel: 'Serializable', timeout: exportCaptureTimeoutMs + 5_000 } as const;

function requestSignal(request: FastifyRequest, reply: FastifyReply) {
	const controller = new AbortController();
	const abort = () => controller.abort();
	request.raw.once('aborted', abort);
	reply.raw.once('close', () => { if (!reply.raw.writableFinished) abort(); });
	if (request.raw.aborted || reply.raw.destroyed) abort();
	return controller.signal;
}

export function registerExports(app: FastifyInstance, database: PrismaClient) {
	const spool = createExportSpool();
	app.get<{ Querystring: EntriesCsvExportQuery }>(entriesCsvExportPath, {
		exposeHeadRoute: false,
		schema: { operationId: 'exportEntriesCsv', querystring: EntriesCsvExportQuery, produces: ['text/csv'], response: errors },
	}, async (request, reply) => {
		const accountId = request.accountSession!.accountId;
		const range = workDateRange(request.query, new Date().toISOString());
		const file = await spool((consume) => database.$transaction((transaction) =>
			consume(entriesCsv(transaction, accountId, range, request.query)), snapshotOptions), false, requestSignal(request, reply));
		return reply
			.type('text/csv; charset=utf-8')
			.header('Content-Disposition', `attachment; filename="timekeeper-entries-${range.from}_to_${range.to}.csv"`)
			.header('Content-Length', file.size)
			.header('X-Content-Type-Options', 'nosniff')
			.send(file.stream);
	});
	app.get(portableExportPath, {
		exposeHeadRoute: false,
		schema: { operationId: 'exportPortableData', querystring: Type.Object({}, { additionalProperties: false }),
			produces: ['application/gzip'], response: errors },
	}, async (request, reply) => {
		const accountId = request.accountSession!.accountId;
		const exportedAt = new Date();
		const file = await spool((consume) => database.$transaction((transaction) =>
			consume(portableArchive(transaction, accountId, exportedAt)), snapshotOptions), true, requestSignal(request, reply));
		return reply
			.type('application/gzip')
			.header('Content-Disposition', `attachment; filename="timekeeper-portable-${exportedAt.toISOString().slice(0, 10)}.ndjson.gz"`)
			.header('Content-Length', file.size)
			.header('X-Content-Type-Options', 'nosniff')
			.send(file.stream);
	});
}
