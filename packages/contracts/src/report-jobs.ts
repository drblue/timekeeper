import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { Uuid } from './primitives.js';
import { ReportPreviewQuery } from './report.js';

export const reportPdfPath = '/api/v1/reports/pdf';
export const reportJobsPath = '/api/v1/jobs';
export const ReportPdfBody = ReportPreviewQuery;
export const ReportJobParams = Type.Object({ id: Uuid }, { additionalProperties: false });
export const ReportJobResponse = Type.Object({
	id: Uuid,
	status: Type.Union([
		Type.Literal('queued'), Type.Literal('running'), Type.Literal('ready'), Type.Literal('failed'), Type.Literal('expired'),
	]),
	createdAt: Type.String(),
	expiresAt: Type.Union([Type.String(), Type.Null()]),
	errorCode: Type.Union([
		Type.Literal('REPORT_RENDER_FAILED'), Type.Literal('REPORT_TIMEOUT'), Type.Literal('REPORT_OUTPUT_TOO_LARGE'), Type.Null(),
	]),
	downloadUrl: Type.Union([Type.String(), Type.Null()]),
}, { additionalProperties: false });

export type ReportPdfBody = Static<typeof ReportPdfBody>;
export type ReportJobParams = Static<typeof ReportJobParams>;
export type ReportJobResponse = Static<typeof ReportJobResponse>;

export function parseReportJobResponse(value: unknown): ReportJobResponse {
	if (!Value.Check(ReportJobResponse, value)) throw new Error('Invalid report job response');
	return value;
}
