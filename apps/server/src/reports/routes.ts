import {
	ApiErrorResponse, maxReportLogoBytes, ReportLogoMutationQuery, ReportLogoParams, reportLogoPath, reportPreviewPath, ReportPreviewQuery,
	ReportPreviewResponse, ReportSettingsBody, reportSettingsPath, ReportSettingsResponse,
} from '@timekeeper/contracts';
import type { FastifyInstance } from 'fastify';
import { ApiRequestError } from '../api-error.ts';
import type { PrismaClient } from '../generated/prisma/client.ts';
import { buildReportData, reportPreview } from './report-data.ts';
import type { createReportSettings } from './settings.ts';

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

const readErrors = { 400: ApiErrorResponse, 401: ApiErrorResponse, 500: ApiErrorResponse };
const writeErrors = { ...readErrors, 403: ApiErrorResponse, 409: ApiErrorResponse, 413: ApiErrorResponse, 415: ApiErrorResponse, 422: ApiErrorResponse };

function expectedLogoId(query: ReportLogoMutationQuery) {
	return query.expectedLogoId === 'none' ? null : query.expectedLogoId;
}

export async function registerReportSettings(app: FastifyInstance, store: ReturnType<typeof createReportSettings>) {
	app.get(reportSettingsPath, {
		schema: { operationId: 'getReportSettings', response: { 200: ReportSettingsResponse, ...readErrors } },
	}, (request) => store.get(request.accountSession!.accountId));
	app.put<{ Body: ReportSettingsBody }>(reportSettingsPath, {
		bodyLimit: 2_048,
		schema: { operationId: 'setReportSettings', body: ReportSettingsBody, response: { 200: ReportSettingsResponse, ...writeErrors } },
	}, (request) => store.setBusinessName(request.accountSession!.accountId, request.body));

	await app.register(async (logos) => {
		logos.addContentTypeParser('image/png', { parseAs: 'buffer' }, (_request, bytes, done) => done(null, bytes));
		logos.put<{ Querystring: ReportLogoMutationQuery }>(reportLogoPath, {
			bodyLimit: maxReportLogoBytes,
			schema: { operationId: 'uploadReportLogo', querystring: ReportLogoMutationQuery,
				consumes: ['image/png'], response: { 200: ReportSettingsResponse, ...writeErrors } },
		}, (request) => {
			if (!Buffer.isBuffer(request.body)) {
				throw new ApiRequestError(422, 'UNSUPPORTED_REPORT_LOGO_TYPE', 'Upload the PNG file directly as image/png.');
			}
			return store.uploadLogo(request.accountSession!.accountId, request.body, expectedLogoId(request.query));
		});
		logos.delete<{ Querystring: ReportLogoMutationQuery }>(reportLogoPath, {
			bodyLimit: 1_024,
			schema: { operationId: 'removeReportLogo', querystring: ReportLogoMutationQuery, response: { 200: ReportSettingsResponse, ...writeErrors } },
		}, (request) => store.removeLogo(request.accountSession!.accountId, expectedLogoId(request.query)));
		logos.get<{ Params: ReportLogoParams }>(`${reportLogoPath}/:id`, {
			schema: { operationId: 'getReportLogo', params: ReportLogoParams, produces: ['image/png'], response: { ...readErrors, 404: ApiErrorResponse } },
		}, async (request, reply) => {
			const bytes = await store.getLogo(request.accountSession!.accountId, request.params.id);
			return reply.type('image/png').header('X-Content-Type-Options', 'nosniff').send(bytes);
		});
	});
}
