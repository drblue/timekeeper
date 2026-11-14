import { ApiErrorResponse, reportPreviewPath, ReportPreviewQuery, ReportPreviewResponse } from '@timekeeper/contracts';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '../generated/prisma/client.ts';
import { buildReportData, reportPreview } from './report-data.ts';

export function createReportPreview(database: PrismaClient, now: () => Date = () => new Date()) {
	return async (accountId: string, query: ReportPreviewQuery) => reportPreview(await buildReportData(database, accountId, query, now()));
}

export function registerReports(app: FastifyInstance, preview: ReturnType<typeof createReportPreview>) {
	app.get<{ Querystring: ReportPreviewQuery }>(reportPreviewPath, {
		schema: {
			operationId: 'previewTimeReport', querystring: ReportPreviewQuery,
			response: { 200: ReportPreviewResponse, 400: ApiErrorResponse, 401: ApiErrorResponse, 422: ApiErrorResponse, 500: ApiErrorResponse },
		},
	}, (request) => preview(request.accountSession!.accountId, request.query));
}
