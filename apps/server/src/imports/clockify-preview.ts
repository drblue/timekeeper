import { createHash } from 'node:crypto';
import { elapsedSeconds, entryTimeZone, maxEntryDurationSeconds, resolveLocalTime } from '@timekeeper/contracts';
import type {
	ClockifyPreviewQuery, ClockifyPreviewResponse, ClockifyPreviewRow, ClockifyRowIssue, ClockifySource, ClockifyTimestamp,
} from '@timekeeper/contracts';
import { ApiRequestError } from '../api-error.ts';
import { validLocalDate } from '../local-date.ts';
import { parseClockifyCsv } from './clockify-csv.ts';

function validateTimeZone(timeZone: string) {
	try {
		if (!/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(timeZone)) throw new RangeError();
		new Intl.DateTimeFormat('en', { timeZone });
	} catch (error) {
		if (!(error instanceof RangeError)) throw error;
		throw new ApiRequestError(422, 'CLOCKIFY_INVALID_TIME_ZONE', 'Enter an IANA timezone such as Europe/Stockholm or UTC.');
	}
	return timeZone;
}

export function sourceDuration(value: string) {
	const match = /^(\d{1,6}):([0-5]\d):([0-5]\d)$/.exec(value);
	if (!match) return null;
	const seconds = Number(match[1]) * 3_600 + Number(match[2]) * 60 + Number(match[3]);
	return seconds > 0 && seconds <= maxEntryDurationSeconds ? seconds : null;
}

function sourceTimestamp(date: string, time: string, timeZone: string): ClockifyTimestamp {
	const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(date);
	const calendarDate = match ? `${match[3]}-${match[2]}-${match[1]}` : '';
	if (!validLocalDate(calendarDate) || !/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(time)) {
		return { local: null, status: 'invalid', candidates: [] };
	}
	const local = `${calendarDate}T${time}`;
	const resolution = resolveLocalTime(local, timeZone);
	if (resolution.status === 'valid') {
		return { local, status: 'valid', candidates: [{ occurrence: null, instant: resolution.instant, offset: resolution.offset }] };
	}
	if (resolution.status === 'ambiguous') {
		return { local, status: 'ambiguous', candidates: [
			{ occurrence: 'earlier', ...resolution.earlier }, { occurrence: 'later', ...resolution.later },
		] };
	}
	return { local, status: resolution.status, candidates: [] };
}

function inspectRow(line: number, source: ClockifySource | null, hasUser: boolean, timeZone: string): ClockifyPreviewRow {
	if (!source) {
		return { line, source, invoicedTag: null, durationSeconds: null, start: null, end: null,
			timestampDurationSeconds: null, issues: ['column-count'], status: 'invalid' };
	}
	const durationSeconds = sourceDuration(source.durationH);
	const start = sourceTimestamp(source.startDate, source.startTime, timeZone);
	const end = sourceTimestamp(source.endDate, source.endTime, timeZone);
	const issues: ClockifyRowIssue[] = [];
	if (!hasUser) issues.push('missing-user');
	if (durationSeconds === null) issues.push('invalid-duration');
	if (start.status === 'invalid' || start.status === 'nonexistent') issues.push(`${start.status}-start`);
	if (end.status === 'invalid' || end.status === 'nonexistent') issues.push(`${end.status}-end`);
	const startCandidate = start.status === 'valid' ? start.candidates[0] : undefined;
	const endCandidate = end.status === 'valid' ? end.candidates[0] : undefined;
	const timestampDurationSeconds = startCandidate && endCandidate ? elapsedSeconds(startCandidate.instant, endCandidate.instant) : null;
	if (timestampDurationSeconds !== null && timestampDurationSeconds <= 0) issues.push('nonpositive-interval');
	const invalid = issues.length > 0;
	if (!source.description.trim()) issues.push('missing-description');
	if (start.status === 'ambiguous') issues.push('ambiguous-start');
	if (end.status === 'ambiguous') issues.push('ambiguous-end');
	if (durationSeconds !== null && timestampDurationSeconds !== null && timestampDurationSeconds > 0 && durationSeconds !== timestampDurationSeconds) {
		issues.push('duration-mismatch');
	}
	const invoicedTag = source.tags.split(',').some((tag) => tag.trim().toLowerCase() === 'invoiced');
	return { line, source, invoicedTag, durationSeconds, start, end, timestampDurationSeconds, issues,
		status: invalid ? 'invalid' : issues.length > 0 ? 'review' : 'valid' };
}

export function previewClockify(bytes: Buffer, query: ClockifyPreviewQuery): ClockifyPreviewResponse {
	const sourceTimeZone = validateTimeZone(query.sourceTimeZone ?? entryTimeZone);
	const records = parseClockifyCsv(bytes);
	const users = new Map<string, ClockifyPreviewResponse['users'][number]>();
	const rowsWithUser = records.map(({ line, source }) => {
		if (!source || (!source.user.trim() && !source.email.trim())) return { line, source, userId: null };
		const { user, email } = source;
		const id = createHash('sha256').update(JSON.stringify([user, email])).digest('hex');
		const existing = users.get(id);
		if (existing) existing.rowCount += 1;
		else users.set(id, { id, user, email, rowCount: 1 });
		return { line, source, userId: id };
	});
	const selectedUserId = query.selectedUserId ?? (users.size === 1 ? users.keys().next().value! : null);
	if (selectedUserId !== null && !users.has(selectedUserId)) {
		throw new ApiRequestError(422, 'CLOCKIFY_UNKNOWN_USER', 'Choose a user found in this Clockify CSV.');
	}
	const counts = { total: records.length, selected: 0, valid: 0, review: 0, invalid: 0, unassigned: 0 };
	const rows: ClockifyPreviewRow[] = [];
	for (const { line, source, userId } of rowsWithUser) {
		if (userId === null) counts.unassigned += 1;
		else if (userId === selectedUserId) counts.selected += 1;
		else continue;
		const row = inspectRow(line, source, userId !== null, sourceTimeZone);
		counts[row.status] += 1;
		rows.push(row);
	}
	return { sourceTimeZone, users: [...users.values()], selectedUserId,
		requiresUserSelection: users.size > 1 && selectedUserId === null, counts, rows };
}
