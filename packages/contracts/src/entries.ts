import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { maxStoredInt, NullableHourlyRate, NullableUuid, Ore, Revision, Uuid } from './primitives.js';

export const entriesPath = '/api/v1/entries';
export const maxEntryDescriptionLength = 4_000;
export const maxEntryDurationSeconds = maxStoredInt;

const kind = Type.Literal('duration-only');
const LocalDate = Type.String({ pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$', description: 'A local calendar date in YYYY-MM-DD form.' });
const DurationSeconds = Type.Integer({ minimum: 1, maximum: maxEntryDurationSeconds });
const strict = { additionalProperties: false };

export const EntryIdParams = Type.Object({ id: Uuid }, strict);
export const EntryListQuery = Type.Object({}, strict);
export const CreateDurationEntryBody = Type.Object({
	kind,
	description: Type.String({ minLength: 1, maxLength: maxEntryDescriptionLength }),
	localDate: LocalDate,
	durationSeconds: DurationSeconds,
	projectId: NullableUuid,
	directClientId: NullableUuid,
	rateOverrideOrePerHour: NullableHourlyRate,
	billable: Type.Optional(Type.Boolean()),
}, strict);

export const DurationEntryResponse = Type.Object({
	id: Uuid,
	kind,
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
}, strict);

export const DurationEntryListResponse = Type.Array(DurationEntryResponse);

export type EntryIdParams = Static<typeof EntryIdParams>;
export type CreateDurationEntryBody = Static<typeof CreateDurationEntryBody>;
export type DurationEntryResponse = Static<typeof DurationEntryResponse>;

export function parseDurationEntryResponse(value: unknown): DurationEntryResponse {
	if (!Value.Check(DurationEntryResponse, value)) {
		throw new Error('Invalid duration-only entry response');
	}
	return value;
}

export function parseDurationEntryListResponse(value: unknown): DurationEntryResponse[] {
	if (!Value.Check(DurationEntryListResponse, value)) {
		throw new Error('Invalid duration-only entry list response');
	}
	return value;
}
