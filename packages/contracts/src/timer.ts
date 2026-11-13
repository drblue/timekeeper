import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { EntryInstant, IncompleteEntryResponse, maxEntryDescriptionLength, TimedEntryResponse } from './entries.js';
import { NullableHourlyRate, NullableUuid, Revision, Uuid } from './primitives.js';

export const timerPath = '/api/v1/timer';
export const timerStartPath = `${timerPath}/start`;
export const timerStopPath = `${timerPath}/stop`;
export const idempotencyKeyHeader = 'idempotency-key';
export const longRunningTimerSeconds = 43_200;

const strict = { additionalProperties: false };
const ServerNow = Type.String({ pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$' });
export const TimerIdempotencyHeaders = Type.Object({ [idempotencyKeyHeader]: Uuid });
export const StartTimerBody = Type.Object({
	description: Type.Optional(Type.String({ maxLength: maxEntryDescriptionLength })),
	projectId: NullableUuid,
	directClientId: NullableUuid,
	rateOverrideOrePerHour: NullableHourlyRate,
	billable: Type.Optional(Type.Boolean()),
}, strict);
export const StopTimerBody = Type.Object({ timerId: Uuid, revision: Revision }, strict);
export const RunningTimerResponse = Type.Object({
	id: Uuid,
	revision: Revision,
	startAt: EntryInstant,
	description: Type.String(),
	projectId: NullableUuid,
	directClientId: NullableUuid,
	clientId: NullableUuid,
	projectName: Type.Union([Type.String(), Type.Null()]),
	clientName: Type.Union([Type.String(), Type.Null()]),
	billable: Type.Boolean(),
	assignedRateOrePerHour: NullableHourlyRate,
}, strict);
export const TimerStateResponse = Type.Object({
	timer: Type.Union([RunningTimerResponse, Type.Null()]),
	serverNow: ServerNow,
}, strict);
export const StopTimerResponse = Type.Object({
	entry: Type.Union([TimedEntryResponse, IncompleteEntryResponse]),
	serverNow: ServerNow,
}, strict);

export type TimerIdempotencyHeaders = Static<typeof TimerIdempotencyHeaders>;
export type StartTimerBody = Static<typeof StartTimerBody>;
export type StopTimerBody = Static<typeof StopTimerBody>;
export type RunningTimerResponse = Static<typeof RunningTimerResponse>;
export type TimerStateResponse = Static<typeof TimerStateResponse>;
export type StopTimerResponse = Static<typeof StopTimerResponse>;

export function parseTimerStateResponse(value: unknown): TimerStateResponse {
	if (!Value.Check(TimerStateResponse, value)) throw new Error('Invalid timer state response');
	return value;
}

export function parseStopTimerResponse(value: unknown): StopTimerResponse {
	if (!Value.Check(StopTimerResponse, value)) throw new Error('Invalid timer stop response');
	return value;
}
