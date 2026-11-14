import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

export const clockifyPreviewPath = '/api/v1/imports/clockify/preview';
export const maxClockifyCsvBytes = 4 * 1024 * 1024;
export const maxClockifyRows = 4_000;

const strict = { additionalProperties: false };
const Text = Type.String();
const Count = Type.Integer({ minimum: 0 });
const UserId = Type.String({ pattern: '^[0-9a-f]{64}$' });
const TimeZone = Type.String({ minLength: 1, maxLength: 128 });
const NullableSeconds = Type.Union([Type.Integer(), Type.Null()]);

export const ClockifyPreviewQuery = Type.Object({
	sourceTimeZone: Type.Optional(TimeZone),
	selectedUserId: Type.Optional(UserId),
}, strict);

export const ClockifySource = Type.Object({
	project: Text,
	client: Text,
	description: Text,
	task: Text,
	user: Text,
	group: Text,
	email: Text,
	tags: Text,
	startDate: Text,
	startTime: Text,
	endDate: Text,
	endTime: Text,
	durationH: Text,
	durationDecimal: Text,
	dateOfCreation: Text,
}, strict);

export const ClockifyTimestamp = Type.Object({
	local: Type.Union([Text, Type.Null()]),
	status: Type.Union([Type.Literal('valid'), Type.Literal('ambiguous'), Type.Literal('nonexistent'), Type.Literal('invalid')]),
	candidates: Type.Array(Type.Object({
		occurrence: Type.Union([Type.Literal('earlier'), Type.Literal('later'), Type.Null()]),
		instant: Text,
		offset: Text,
	}, strict), { maxItems: 2 }),
}, strict);

export const ClockifyRowIssue = Type.Union([
	Type.Literal('column-count'), Type.Literal('missing-user'), Type.Literal('missing-description'), Type.Literal('invalid-duration'),
	Type.Literal('invalid-start'), Type.Literal('invalid-end'), Type.Literal('ambiguous-start'), Type.Literal('ambiguous-end'),
	Type.Literal('nonexistent-start'), Type.Literal('nonexistent-end'), Type.Literal('nonpositive-interval'), Type.Literal('duration-mismatch'),
]);

export const ClockifyPreviewRow = Type.Object({
	line: Type.Integer({ minimum: 2 }),
	source: Type.Union([ClockifySource, Type.Null()]),
	invoicedTag: Type.Union([Type.Boolean(), Type.Null()]),
	durationSeconds: NullableSeconds,
	start: Type.Union([ClockifyTimestamp, Type.Null()]),
	end: Type.Union([ClockifyTimestamp, Type.Null()]),
	timestampDurationSeconds: NullableSeconds,
	issues: Type.Array(ClockifyRowIssue),
	status: Type.Union([Type.Literal('valid'), Type.Literal('review'), Type.Literal('invalid')]),
}, strict);

export const ClockifyPreviewResponse = Type.Object({
	sourceTimeZone: TimeZone,
	users: Type.Array(Type.Object({ id: UserId, user: Text, email: Text, rowCount: Count }, strict), { maxItems: maxClockifyRows }),
	selectedUserId: Type.Union([UserId, Type.Null()]),
	requiresUserSelection: Type.Boolean(),
	counts: Type.Object({ total: Count, selected: Count, valid: Count, review: Count, invalid: Count, unassigned: Count }, strict),
	rows: Type.Array(ClockifyPreviewRow, { maxItems: maxClockifyRows }),
}, strict);

export type ClockifyPreviewQuery = Static<typeof ClockifyPreviewQuery>;
export type ClockifySource = Static<typeof ClockifySource>;
export type ClockifyTimestamp = Static<typeof ClockifyTimestamp>;
export type ClockifyRowIssue = Static<typeof ClockifyRowIssue>;
export type ClockifyPreviewRow = Static<typeof ClockifyPreviewRow>;
export type ClockifyPreviewResponse = Static<typeof ClockifyPreviewResponse>;

export function parseClockifyPreviewResponse(value: unknown): ClockifyPreviewResponse {
	if (!Value.Check(ClockifyPreviewResponse, value)) throw new Error('Invalid Clockify inspection response');
	return value;
}
