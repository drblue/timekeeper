import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { DurationEntryResponse, EntryLocalDate, IncompleteEntryResponse, maxEntryDurationSeconds, TimedEntryResponse } from './entries.js';
import { Ore, Uuid } from './primitives.js';

export const workListPath = '/api/v1/entries/list';
export const defaultWorkListPageSize = 25;
export const maxWorkListPageSize = 100;
const strict = { additionalProperties: false };

export const WorkListPreset = Type.Union([
	Type.Literal('today'), Type.Literal('this-week'), Type.Literal('this-month'), Type.Literal('previous-month'), Type.Literal('custom'),
]);
export const WorkListInvoice = Type.Union([Type.Literal('all'), Type.Literal('invoiced'), Type.Literal('not-yet-invoiced')]);
export const WorkListBillability = Type.Union([Type.Literal('all'), Type.Literal('billable'), Type.Literal('non-billable')]);
export const WorkListSort = Type.Union([Type.Literal('newest'), Type.Literal('oldest')]);

export const WorkListQuery = Type.Object({
	preset: Type.Optional(WorkListPreset),
	from: Type.Optional(EntryLocalDate),
	to: Type.Optional(EntryLocalDate),
	clientId: Type.Optional(Uuid),
	projectId: Type.Optional(Uuid),
	invoice: Type.Optional(WorkListInvoice),
	billability: Type.Optional(WorkListBillability),
	description: Type.Optional(Type.String({ maxLength: 256 })),
	invoiceNumber: Type.Optional(Type.String({ maxLength: 256 })),
	sort: Type.Optional(WorkListSort),
	page: Type.Optional(Type.String({ pattern: '^[1-9][0-9]{0,8}$' })),
	pageSize: Type.Optional(Type.String({ pattern: '^[1-9][0-9]{0,2}$' })),
}, strict);

export const WorkListRange = Type.Object({ from: EntryLocalDate, to: EntryLocalDate }, strict);
const WorkListRow = Type.Object({
	entry: Type.Union([DurationEntryResponse, TimedEntryResponse]),
	seconds: Type.Integer({ minimum: 1, maximum: maxEntryDurationSeconds }),
	amountOre: Ore,
}, strict);

export const WorkListResponse = Type.Object({
	range: WorkListRange,
	page: Type.Integer({ minimum: 1 }),
	pageSize: Type.Integer({ minimum: 1, maximum: maxWorkListPageSize }),
	totalRows: Type.Integer({ minimum: 0 }),
	totalPages: Type.Integer({ minimum: 1 }),
	totals: Type.Object({
		seconds: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		amountOre: Type.String({ pattern: '^(0|[1-9][0-9]*)$' }),
	}, strict),
	groups: Type.Array(Type.Object({ localDate: EntryLocalDate, rows: Type.Array(WorkListRow) }, strict)),
	incomplete: Type.Array(IncompleteEntryResponse),
	incompatibleSelection: Type.Boolean(),
}, strict);

export type WorkListPreset = Static<typeof WorkListPreset>;
export type WorkListInvoice = Static<typeof WorkListInvoice>;
export type WorkListBillability = Static<typeof WorkListBillability>;
export type WorkListSort = Static<typeof WorkListSort>;
export type WorkListQuery = Static<typeof WorkListQuery>;
export type WorkListRange = Static<typeof WorkListRange>;
export type WorkListResponse = Static<typeof WorkListResponse>;

export function parseWorkListResponse(value: unknown): WorkListResponse {
	if (!Value.Check(WorkListResponse, value)) throw new Error('Invalid work list response');
	return value;
}
