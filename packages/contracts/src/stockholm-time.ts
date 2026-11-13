import { Temporal } from 'temporal-polyfill';

export const entryTimeZone = 'Europe/Stockholm';
export type LocalTimeOccurrence = 'earlier' | 'later';
export const entryLocalDateTimePattern = '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2})?$';
const entryLocalDateTime = new RegExp(entryLocalDateTimePattern);

export interface StockholmInstantCandidate {
	instant: string;
	offset: string;
}

export type StockholmLocalTimeResolution =
	| ({ status: 'valid' } & StockholmInstantCandidate)
	| { status: 'ambiguous'; earlier: StockholmInstantCandidate; later: StockholmInstantCandidate }
	| { status: 'nonexistent' }
	| { status: 'invalid' };

function candidate(time: Temporal.ZonedDateTime): StockholmInstantCandidate {
	return { instant: time.toInstant().toString({ fractionalSecondDigits: 3 }), offset: time.offset };
}

export function resolveStockholmLocalTime(local: string): StockholmLocalTimeResolution {
	if (!entryLocalDateTime.test(local) || local.startsWith('0000-') || local.slice(17) === '60') {
		return { status: 'invalid' };
	}
	let time: Temporal.PlainDateTime;
	try {
		time = Temporal.PlainDateTime.from(local);
	} catch (error) {
		if (error instanceof RangeError) return { status: 'invalid' };
		throw error;
	}
	const earlier = time.toZonedDateTime(entryTimeZone, { disambiguation: 'earlier' });
	if (!earlier.toPlainDateTime().equals(time)) {
		return { status: 'nonexistent' };
	}
	const later = time.toZonedDateTime(entryTimeZone, { disambiguation: 'later' });
	return earlier.epochNanoseconds === later.epochNanoseconds
		? { status: 'valid', ...candidate(earlier) }
		: { status: 'ambiguous', earlier: candidate(earlier), later: candidate(later) };
}

export function formatStockholmLocalTime(instant: string): { local: string; offset: string } {
	const zoned = Temporal.Instant.from(instant).toZonedDateTimeISO(entryTimeZone);
	return { local: zoned.toPlainDateTime().toString({ smallestUnit: 'second' }), offset: zoned.offset };
}

export function elapsedSeconds(startAt: string, endAt: string): number {
	return (Temporal.Instant.from(endAt).epochMilliseconds - Temporal.Instant.from(startAt).epochMilliseconds) / 1_000;
}

export function nextStockholmDayStart(localDate: string): { localDate: string; epochMilliseconds: number } {
	const next = Temporal.PlainDate.from(localDate).add({ days: 1 }).toZonedDateTime(entryTimeZone);
	return { localDate: next.toPlainDate().toString(), epochMilliseconds: next.epochMilliseconds };
}
