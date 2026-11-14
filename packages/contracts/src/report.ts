import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { EntryLocalDate } from './entries.js';
import { NullableHourlyRate, NullableUuid } from './primitives.js';
import { WorkListBillability, WorkListInvoice, workScopeFields } from './work-list.js';

export const reportPreviewPath = '/api/v1/reports/preview';
export const maxReportDays = 3_660;
const strict = { additionalProperties: false };
const NullableName = Type.Union([Type.String(), Type.Null()]);
const Seconds = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const Amount = Type.String({ pattern: '^(0|[1-9][0-9]*)$' });
const project = { projectId: NullableUuid, projectName: NullableName, clientName: NullableName };

export const ReportPreviewQuery = Type.Object({
	...workScopeFields,
	showMoney: Type.Optional(Type.Union([Type.Literal('true'), Type.Literal('false')])),
}, strict);

export const ReportPreviewResponse = Type.Object({
	showMoney: Type.Boolean(),
	scope: Type.Object({
		from: EntryLocalDate, to: EntryLocalDate, clientId: NullableUuid, ...project,
		invoice: WorkListInvoice, billability: WorkListBillability, description: Type.String(), invoiceNumber: Type.String(),
	}, strict),
	totalSeconds: Seconds,
	totalAmountOre: Amount,
	days: Type.Array(Type.Object({ date: EntryLocalDate, seconds: Seconds }, strict), { minItems: 1, maxItems: maxReportDays }),
	projectShares: Type.Array(Type.Object({ ...project, seconds: Seconds }, strict)),
	summaries: Type.Array(Type.Object({
		...project, clientId: NullableUuid, description: Type.String(), seconds: Seconds, hourlyRateOre: NullableHourlyRate, amountOre: Amount,
	}, strict)),
	incompatibleSelection: Type.Boolean(),
}, strict);

export type ReportPreviewQuery = Static<typeof ReportPreviewQuery>;
export type ReportPreviewResponse = Static<typeof ReportPreviewResponse>;

export function parseReportPreviewResponse(value: unknown): ReportPreviewResponse {
	if (!Value.Check(ReportPreviewResponse, value)) throw new Error('Invalid time report preview');
	return value;
}
