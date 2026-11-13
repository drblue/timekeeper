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
const Instant = Type.String({ pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.000Z$' });
const Occurrence = Type.Optional(Type.Union([Type.Literal('earlier'), Type.Literal('later')]));
const DurationSeconds = Type.Integer({ minimum: 1, maximum: maxEntryDurationSeconds });
const strict = { additionalProperties: false };

export const EntryIdParams = Type.Object({ id: Uuid }, strict);
export const EntryListQuery = Type.Object({}, strict);
const entryInput = {
	description: Type.String({ minLength: 1, maxLength: maxEntryDescriptionLength }),
	projectId: NullableUuid,
	directClientId: NullableUuid,
	rateOverrideOrePerHour: NullableHourlyRate,
	billable: Type.Optional(Type.Boolean()),
};

export const CreateDurationEntryBody = Type.Object({
	kind: Type.Literal('duration-only'),
	...entryInput,
	localDate: LocalDate,
	durationSeconds: DurationSeconds,
}, strict);
export const CreateTimedEntryBody = Type.Object({
	kind: Type.Literal('timed'),
	...entryInput,
	startLocal: LocalDateTime,
	endLocal: LocalDateTime,
	startOccurrence: Occurrence,
	endOccurrence: Occurrence,
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
};

export const DurationEntryResponse = Type.Object({
	kind: Type.Literal('duration-only'),
	...entryOutput,
}, strict);
export const TimedEntryResponse = Type.Object({
	kind: Type.Literal('timed'),
	...entryOutput,
	startAt: Instant,
	endAt: Instant,
	allocations: Type.Array(Type.Object({ localDate: LocalDate, seconds: DurationSeconds, amountOre: Ore }, strict), { minItems: 1 }),
}, strict);
export const EntryResponse = Type.Union([DurationEntryResponse, TimedEntryResponse]);
export const EntryListResponse = Type.Array(EntryResponse);

export type EntryIdParams = Static<typeof EntryIdParams>;
export type CreateDurationEntryBody = Static<typeof CreateDurationEntryBody>;
export type CreateTimedEntryBody = Static<typeof CreateTimedEntryBody>;
export type CreateEntryBody = Static<typeof CreateEntryBody>;
export type DurationEntryResponse = Static<typeof DurationEntryResponse>;
export type TimedEntryResponse = Static<typeof TimedEntryResponse>;
export type EntryResponse = Static<typeof EntryResponse>;

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
