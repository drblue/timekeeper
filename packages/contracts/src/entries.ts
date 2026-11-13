import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { maxStoredInt, NullableHourlyRate, NullableUuid, Ore, Revision, Uuid } from './primitives.js';
import { entryLocalDateTimePattern } from './stockholm-time.js';

export const entriesPath = '/api/v1/entries';
export const maxEntryDescriptionLength = 4_000;
export const maxEntryDurationSeconds = maxStoredInt;

const LocalDate = Type.String({ pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$', description: 'A local calendar date in YYYY-MM-DD form.' });
const LocalDateTime = Type.String({ pattern: entryLocalDateTimePattern, description: 'Local date and time in Europe/Stockholm.' });
export const EntryInstant = Type.String({ pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.000Z$' });
const Occurrence = Type.Optional(Type.Union([Type.Literal('earlier'), Type.Literal('later')]));
const DurationSeconds = Type.Integer({ minimum: 1, maximum: maxEntryDurationSeconds });
const strict = { additionalProperties: false };
const Timestamp = Type.String({ pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$' });

export const EntryIdParams = Type.Object({ id: Uuid }, strict);
export const EntryListQuery = Type.Object({}, strict);
const entryInput = {
	description: Type.String({ minLength: 1, maxLength: maxEntryDescriptionLength }),
	projectId: NullableUuid,
	directClientId: NullableUuid,
	rateOverrideOrePerHour: NullableHourlyRate,
	billable: Type.Optional(Type.Boolean()),
};

const durationTime = {
	kind: Type.Literal('duration-only'),
	localDate: LocalDate,
	durationSeconds: DurationSeconds,
};
const timedTime = {
	kind: Type.Literal('timed'),
	startLocal: LocalDateTime,
	endLocal: LocalDateTime,
	startOccurrence: Occurrence,
	endOccurrence: Occurrence,
};
export const CreateDurationEntryBody = Type.Object({ ...durationTime, ...entryInput }, strict);
export const CreateTimedEntryBody = Type.Object({
	...timedTime,
	...entryInput,
	confirmOverlap: Type.Optional(Type.Boolean()),
}, strict);
export const CreateEntryBody = Type.Union([CreateDurationEntryBody, CreateTimedEntryBody]);

const entryOutput = {
	id: Uuid,
	// JSON Schema input checks count Unicode code points, while TypeBox response checks count code units.
	description: Type.String({ minLength: 1 }),
	localDate: LocalDate,
	durationSeconds: DurationSeconds,
	projectId: NullableUuid,
	directClientId: NullableUuid,
	clientId: NullableUuid,
	projectName: Type.Union([Type.String(), Type.Null()]),
	clientName: Type.Union([Type.String(), Type.Null()]),
	billable: Type.Boolean(),
	assignedRateOrePerHour: NullableHourlyRate,
	billableAmountOre: Ore,
	revision: Revision,
	invoicedAt: Type.Optional(Timestamp),
};

export const DurationEntryResponse = Type.Object({
	kind: Type.Literal('duration-only'),
	completion: Type.Literal('complete'),
	...entryOutput,
}, strict);
export const TimedEntryResponse = Type.Object({
	kind: Type.Literal('timed'),
	completion: Type.Literal('complete'),
	...entryOutput,
	startAt: EntryInstant,
	endAt: EntryInstant,
	allocations: Type.Array(Type.Object({ localDate: LocalDate, seconds: DurationSeconds, amountOre: Ore }, strict), { minItems: 1 }),
}, strict);
export const IncompleteEntryResponse = Type.Object({
	kind: Type.Literal('timed'),
	completion: Type.Literal('incomplete'),
	...entryOutput,
	description: Type.String(),
	durationSeconds: Type.Integer({ minimum: 0, maximum: maxEntryDurationSeconds }),
	billableAmountOre: Type.Null(),
	startAt: EntryInstant,
	endAt: EntryInstant,
	allocations: Type.Tuple([]),
	missingFields: Type.Array(Type.Union([
		Type.Literal('description'), Type.Literal('rate'), Type.Literal('duration'), Type.Literal('amount'),
	]), { minItems: 1, uniqueItems: true }),
}, strict);
export const EntryResponse = Type.Union([DurationEntryResponse, TimedEntryResponse, IncompleteEntryResponse]);
export const EntryListResponse = Type.Array(EntryResponse);
export const CompleteEntryBody = Type.Object({
	revision: Revision,
	description: entryInput.description,
	rateOverrideOrePerHour: NullableHourlyRate,
	billable: Type.Optional(Type.Boolean()),
	durationSeconds: Type.Optional(DurationSeconds),
}, strict);
export const EntryEditTime = Type.Union([Type.Object(durationTime, strict), Type.Object(timedTime, strict)]);
export const EntryEditBody = Type.Object({
	revision: Revision,
	description: entryInput.description,
	projectId: NullableUuid,
	directClientId: NullableUuid,
	billable: Type.Boolean(),
	rate: Type.Optional(Type.Union([
		Type.Object({ mode: Type.Literal('keep') }, strict),
		Type.Object({ mode: Type.Literal('current'), expectedDefaultRateOrePerHour: NullableHourlyRate }, strict),
		Type.Object({ mode: Type.Literal('override'), rateOrePerHour: Ore }, strict),
	])),
	time: Type.Optional(EntryEditTime),
	confirmOverlap: Type.Optional(Type.Boolean()),
}, strict);
export const EntryEditPreview = Type.Object({
	durationSeconds: DurationSeconds,
	billableAmountOre: Ore,
	assignedRateOrePerHour: NullableHourlyRate,
	overlap: Type.Boolean(),
}, strict);
export const EntryHistoryResponse = Type.Array(Type.Object({
	id: Uuid,
	action: Type.Union([Type.Literal('created'), Type.Literal('completed'), Type.Literal('edited')]),
	at: Timestamp,
	before: Type.Union([EntryResponse, Type.Null()]),
	after: EntryResponse,
}, strict));

export type EntryIdParams = Static<typeof EntryIdParams>;
export type CreateDurationEntryBody = Static<typeof CreateDurationEntryBody>;
export type CreateTimedEntryBody = Static<typeof CreateTimedEntryBody>;
export type CreateEntryBody = Static<typeof CreateEntryBody>;
export type DurationEntryResponse = Static<typeof DurationEntryResponse>;
export type TimedEntryResponse = Static<typeof TimedEntryResponse>;
export type IncompleteEntryResponse = Static<typeof IncompleteEntryResponse>;
export type CompleteEntryBody = Static<typeof CompleteEntryBody>;
export type EntryResponse = Static<typeof EntryResponse>;
export type EntryEditTime = Static<typeof EntryEditTime>;
export type EntryEditBody = Static<typeof EntryEditBody>;
export type EntryEditPreview = Static<typeof EntryEditPreview>;
export type EntryHistoryResponse = Static<typeof EntryHistoryResponse>;

export function parseEntryResponse(value: unknown): EntryResponse {
	if (!Value.Check(EntryResponse, value)) {
		throw new Error('Invalid entry response');
	}
	return value;
}

export function parseEntryListResponse(value: unknown): EntryResponse[] {
	if (!Value.Check(EntryListResponse, value)) {
		throw new Error('Invalid entry list response');
	}
	return value;
}

export function parseEntryEditPreview(value: unknown): EntryEditPreview {
	if (!Value.Check(EntryEditPreview, value)) throw new Error('Invalid entry edit preview');
	return value;
}

export function parseEntryHistoryResponse(value: unknown): EntryHistoryResponse {
	if (!Value.Check(EntryHistoryResponse, value)) throw new Error('Invalid entry history response');
	return value;
}
