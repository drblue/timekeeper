import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { entriesPath, entryInvoiceFields, EntryInstant, EntryLocalDate } from './entries.js';
import { Ore, Revision, Uuid } from './primitives.js';
import { WorkListQuery, WorkListRange } from './work-list.js';

export const bulkEntryPreviewPath = `${entriesPath}/bulk/preview`;
export const bulkEntryCommitPath = `${entriesPath}/bulk/commit`;
const strict = { additionalProperties: false };
const BulkAction = Type.Union([Type.Literal('mark-invoiced'), Type.Literal('unmark-invoiced'), Type.Literal('delete')]);
const BulkIssue = Type.Union([
	Type.Literal('not-completed'), Type.Literal('non-billable'), Type.Literal('already-invoiced'),
	Type.Literal('not-invoiced'), Type.Literal('invoiced-delete'), Type.Literal('outside-date-range'), Type.Literal('outside-selection'),
]);
export const BulkEntryPreviewBody = Type.Object({
	action: BulkAction,
	filters: WorkListQuery,
	selection: Type.Union([
		Type.Object({ mode: Type.Literal('explicit'), entryIds: Type.Array(Uuid, { minItems: 1, maxItems: 1_000 }) }, strict),
		Type.Object({ mode: Type.Literal('all-matching') }, strict),
	]),
	metadata: Type.Optional(Type.Object(entryInvoiceFields, strict)),
	splitOutsideRange: Type.Optional(Type.Boolean()),
}, strict);
const BulkSplitPortion = Type.Object({
	startAt: EntryInstant, endAt: EntryInstant, from: EntryLocalDate, to: EntryLocalDate,
	seconds: Type.Integer({ minimum: 1 }), amountOre: Ore, willInvoice: Type.Boolean(),
}, strict);
const BulkSplitPreview = Type.Object({ portions: Type.Array(BulkSplitPortion, { minItems: 2, maxItems: 3 }) }, strict);
export const BulkEntryPreviewResponse = Type.Object({
	action: BulkAction,
	range: WorkListRange,
	count: Type.Integer({ minimum: 0 }),
	seconds: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
	amountOre: Type.String({ pattern: '^(0|[1-9][0-9]*)$' }),
	invoiceTotals: Type.Optional(Type.Object({ seconds: Type.Integer({ minimum: 0 }), amountOre: Type.String({ pattern: '^(0|[1-9][0-9]*)$' }) }, strict)),
	entries: Type.Array(Type.Object({
		id: Uuid,
		revision: Revision,
		description: Type.String(),
		seconds: Type.Integer({ minimum: 0 }),
		amountOre: Type.Union([Ore, Type.Null()]),
		issues: Type.Array(BulkIssue),
		split: Type.Optional(BulkSplitPreview),
	}, strict)),
	canCommit: Type.Boolean(),
	previewToken: Type.Union([Uuid, Type.Null()]),
}, strict);
export const BulkEntryCommitBody = Type.Object({ previewToken: Uuid }, strict);
export const BulkEntryCommitResponse = Type.Object({
	action: BulkAction,
	count: Type.Integer({ minimum: 1 }),
	entryIds: Type.Array(Uuid, { minItems: 1 }),
	serverNow: Type.String({ pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$' }),
	splits: Type.Optional(Type.Array(Type.Object({ originalEntryId: Uuid, childEntryIds: Type.Array(Uuid, { minItems: 2, maxItems: 3 }) }, strict))),
}, strict);

export type BulkEntryPreviewBody = Static<typeof BulkEntryPreviewBody>;
export type BulkEntryPreviewResponse = Static<typeof BulkEntryPreviewResponse>;
export type BulkEntryCommitBody = Static<typeof BulkEntryCommitBody>;
export type BulkEntryCommitResponse = Static<typeof BulkEntryCommitResponse>;
export type BulkSplitPortion = Static<typeof BulkSplitPortion>;

export function parseBulkEntryPreviewResponse(value: unknown): BulkEntryPreviewResponse {
	if (!Value.Check(BulkEntryPreviewResponse, value)) throw new Error('Invalid bulk entry preview');
	return value;
}

export function parseBulkEntryCommitResponse(value: unknown): BulkEntryCommitResponse {
	if (!Value.Check(BulkEntryCommitResponse, value)) throw new Error('Invalid bulk entry commit');
	return value;
}
