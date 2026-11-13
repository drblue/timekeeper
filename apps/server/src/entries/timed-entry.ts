import { formatStockholmLocalTime, maxEntryDurationSeconds, nextStockholmDayStart, resolveStockholmLocalTime } from '@timekeeper/contracts';
import type { CreateTimedEntryBody, LocalTimeOccurrence } from '@timekeeper/contracts';
import { ApiRequestError } from '../api-error.ts';

export interface EntryDaySegment {
	localDate: string;
	seconds: number;
}

function resolveInstant(local: string, occurrence: LocalTimeOccurrence | undefined, endpoint: 'start' | 'end'): string {
	const resolution = resolveStockholmLocalTime(local);
	switch (resolution.status) {
		case 'valid':
			return resolution.instant;
		case 'ambiguous':
			if (occurrence) return resolution[occurrence].instant;
			throw new ApiRequestError(422, 'AMBIGUOUS_LOCAL_TIME', 'Choose which occurrence of this time to use.', `${endpoint}Occurrence`);
		case 'nonexistent':
			throw new ApiRequestError(422, 'NONEXISTENT_LOCAL_TIME', 'This time does not occur in Europe/Stockholm. Choose a different time.', `${endpoint}Local`);
		case 'invalid':
			throw new ApiRequestError(422, 'INVALID_LOCAL_TIME', 'Enter a valid calendar date and time.', `${endpoint}Local`);
	}
}

export function timedInterval(startAt: Date, endAt: Date) {
	const startMillis = startAt.getTime();
	const endMillis = endAt.getTime();
	const durationSeconds = (endMillis - startMillis) / 1_000;
	if (durationSeconds <= 0) {
		throw new ApiRequestError(422, 'INVALID_TIME_RANGE', 'End time must be after start time.', 'endLocal');
	}
	if (!Number.isInteger(startMillis / 1_000) || !Number.isInteger(endMillis / 1_000) || durationSeconds > maxEntryDurationSeconds) {
		throw new ApiRequestError(422, 'INVALID_DURATION', 'The elapsed duration is outside the supported range.', 'endLocal');
	}

	const localDate = formatStockholmLocalTime(startAt.toISOString()).local.slice(0, 10);
	const segments: EntryDaySegment[] = [];
	let date = localDate;
	let cursor = startMillis;
	while (cursor < endMillis) {
		const nextDayStart = nextStockholmDayStart(date);
		const boundary = Math.min(nextDayStart.epochMilliseconds, endMillis);
		segments.push({ localDate: date, seconds: (boundary - cursor) / 1_000 });
		cursor = boundary;
		date = nextDayStart.localDate;
	}
	return { startAt, endAt, localDate, durationSeconds, segments };
}

export function manualTimedInterval(input: CreateTimedEntryBody) {
	return timedInterval(
		new Date(resolveInstant(input.startLocal, input.startOccurrence, 'start')),
		new Date(resolveInstant(input.endLocal, input.endOccurrence, 'end')),
	);
}

export function allocateEntryAmount(segments: EntryDaySegment[], durationSeconds: number, amountOre: bigint) {
	const seconds = BigInt(durationSeconds);
	let cumulativeSeconds = 0n;
	let allocatedAmountOre = 0n;
	return segments.map((segment) => {
		cumulativeSeconds += BigInt(segment.seconds);
		const cumulativeAmountOre = (2n * amountOre * cumulativeSeconds + seconds) / (2n * seconds);
		const dayAmountOre = cumulativeAmountOre - allocatedAmountOre;
		allocatedAmountOre = cumulativeAmountOre;
		return { ...segment, amountOre: dayAmountOre };
	});
}
