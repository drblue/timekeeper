import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { Uuid } from './primitives.js';

export const reportSettingsPath = '/api/v1/settings/report';
export const reportLogoPath = `${reportSettingsPath}/logo`;
export const maxReportBusinessNameLength = 160;
export const maxReportLogoBytes = 1_048_576;
export const maxReportLogoDimension = 1_600;
const strict = { additionalProperties: false };

export const ReportSettingsBody = Type.Object({
	businessName: Type.Union([Type.String({ maxLength: maxReportBusinessNameLength }), Type.Null()]),
}, strict);
export const ReportLogoParams = Type.Object({ id: Uuid }, strict);
export const ReportLogoMutationQuery = Type.Object({ expectedLogoId: Type.Union([Uuid, Type.Literal('none')]) }, strict);
export const ReportSettingsResponse = Type.Object({
	businessName: Type.Union([Type.String(), Type.Null()]),
	logo: Type.Union([Type.Object({
		id: Uuid,
		url: Type.String({ pattern: `^${reportLogoPath}/[0-9a-f-]{36}$` }),
		width: Type.Integer({ minimum: 1, maximum: maxReportLogoDimension }),
		height: Type.Integer({ minimum: 1, maximum: maxReportLogoDimension }),
	}, strict), Type.Null()]),
}, strict);

export type ReportSettingsBody = Static<typeof ReportSettingsBody>;
export type ReportLogoParams = Static<typeof ReportLogoParams>;
export type ReportLogoMutationQuery = Static<typeof ReportLogoMutationQuery>;
export type ReportSettingsResponse = Static<typeof ReportSettingsResponse>;

export function parseReportSettingsResponse(value: unknown): ReportSettingsResponse {
	if (!Value.Check(ReportSettingsResponse, value)) throw new Error('Invalid report settings response');
	return value;
}
