import { elapsedSeconds, formatStockholmLocalTime, maxEntryDurationSeconds, resolveStockholmLocalTime } from '@timekeeper/contracts';
import type { LocalTimeOccurrence, StockholmLocalTimeResolution } from '@timekeeper/contracts';

const pad = (value: number) => String(value).padStart(2, '0');
const timeUnit = /^[0-5][0-9]$/;

export function formatDurationInput(seconds: number): string {
	return [
		pad(Math.floor(seconds / 3600)),
		pad(Math.floor(seconds / 60) % 60),
		pad(seconds % 60),
	].join(':');
}

export function parseDurationInput(raw: string): number | null {
	const value = raw.trim();
	const match = /^(\d{1,6}):([0-5]\d):([0-5]\d)$/.exec(value);
	let hours = '';
	let minutes = '';
	let seconds = '';
	if (match) {
		[, hours = '', minutes = '', seconds = ''] = match;
	} else if (/^\d{1,10}$/.test(value)) {
		const digits = value.padStart(5, '0');
		hours = digits.slice(0, -4);
		minutes = digits.slice(-4, -2);
		seconds = digits.slice(-2);
	} else {
		return null;
	}
	if (!timeUnit.test(minutes) || !timeUnit.test(seconds)) return null;
	return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
}

export function parseClockInput(raw: string): string | null {
	const value = raw.trim();
	const match = /^(\d{1,2}):([0-5]\d)(?::([0-5]\d))?$/.exec(value);
	let hours = '';
	let minutes = '';
	let seconds = '';
	if (match) {
		[, hours = '', minutes = '', seconds = '00'] = match;
	} else if (/^\d{3,6}$/.test(value)) {
		const digits = value.length === 3 || value.length === 5 ? '0' + value : value;
		hours = digits.slice(0, 2);
		minutes = digits.slice(2, 4);
		seconds = digits.slice(4) || '00';
	} else {
		return null;
	}
	if (Number(hours) > 23 || !timeUnit.test(minutes) || !timeUnit.test(seconds)) return null;
	return [pad(Number(hours)), minutes, seconds].join(':');
}

export function displayClock(clock: string): string {
	return clock.endsWith(':00') ? clock.slice(0, -3) : clock;
}

export function durationError(raw: string, duration = parseDurationInput(raw)): string | undefined {
	if (duration === null) return raw.trim() ? 'Enter a duration such as 3000 or 00:30:00.' : 'Enter a duration.';
	if (duration === 0) return 'Enter a duration greater than zero.';
	if (duration > maxEntryDurationSeconds) return 'Enter a shorter duration.';
}

export interface EntryBoundary {
	date: string;
	time: string;
	occurrence?: LocalTimeOccurrence;
}

export function updateBoundary(boundary: EntryBoundary, change: Partial<EntryBoundary>): EntryBoundary {
	const next = { ...boundary, ...change };
	if (next.date !== boundary.date || parseClockInput(next.time) !== parseClockInput(boundary.time)) {
		next.occurrence = undefined;
	}
	return next;
}

export interface TimingDraft {
	start: EntryBoundary;
	end: EntryBoundary;
	duration: string;
	anchor: 'end' | 'duration';
}

const missingBoundary: EntryBoundary = { date: '', time: '' };

interface BoundaryResolution {
	dateError?: string;
	timeError?: string;
	occurrenceError?: string;
	local?: string;
	instant?: string;
	choices?: Extract<StockholmLocalTimeResolution, { status: 'ambiguous' }>;
}

export function resolveBoundary(boundary: EntryBoundary): BoundaryResolution {
	const dateError = boundary.date ? undefined : 'Enter a date.';
	const clock = parseClockInput(boundary.time);
	const timeError = clock ? undefined : boundary.time.trim() ? 'Enter a 24-hour time such as 0900 or 09:00.' : 'Enter a time.';
	if (!boundary.date || !clock) return { dateError, timeError };

	const local = boundary.date + 'T' + clock;
	const resolved = resolveStockholmLocalTime(local);
	if (resolved.status === 'invalid') return { dateError: 'Enter a supported date.' };
	if (resolved.status === 'nonexistent') return { timeError: 'This time does not exist in Stockholm on this date.' };
	if (resolved.status === 'valid') return { local, instant: resolved.instant };

	const occurrence = boundary.occurrence;
	return {
		local,
		instant: occurrence ? resolved[occurrence].instant : undefined,
		choices: resolved,
		occurrenceError: occurrence ? undefined : 'Choose which occurrence of this time you mean.',
	};
}

export function boundaryFromInstant(instant: string): EntryBoundary {
	const { local } = formatStockholmLocalTime(instant);
	const [date = '', time = ''] = local.split('T');
	const resolved = resolveStockholmLocalTime(local);
	const occurrence = resolved.status === 'ambiguous'
		? resolved.earlier.instant === instant ? 'earlier' : 'later'
		: undefined;
	return { date, time: displayClock(time), occurrence };
}

function computedEnd(start: string, duration: number): EntryBoundary | undefined {
	try {
		const instant = new Date(Date.parse(start) + duration * 1000).toISOString();
		const end = boundaryFromInstant(instant);
		if (resolveBoundary(end).instant) return end;
	} catch (error) {
		if (!(error instanceof RangeError)) throw error;
	}
}

export function calculateTiming(draft: TimingDraft) {
	const start = resolveBoundary(draft.start);
	if (draft.anchor === 'duration') {
		const seconds = parseDurationInput(draft.duration);
		const error = durationError(draft.duration, seconds);
		const end = start.instant && seconds !== null && !error ? computedEnd(start.instant, seconds) : undefined;
		return {
			start,
			end: end ?? missingBoundary,
			endResolution: end ? resolveBoundary(end) : {},
			duration: draft.duration,
			durationError: error ?? (start.instant && !end ? 'Enter a duration that ends within the supported dates.' : undefined),
			rangeError: undefined,
		};
	}
	const endResolution = resolveBoundary(draft.end);
	const seconds = start.instant && endResolution.instant
		? elapsedSeconds(start.instant, endResolution.instant)
		: null;
	const rangeError = seconds !== null && seconds <= 0
		? 'End must be after start. Change the end date if the work ends the next day.'
		: seconds !== null && seconds > maxEntryDurationSeconds
			? 'Enter an end date closer to the start date.'
			: undefined;
	return {
		start,
		end: draft.end,
		endResolution,
		duration: seconds !== null && !rangeError ? formatDurationInput(seconds) : '',
		durationError: undefined,
		rangeError,
	};
}
