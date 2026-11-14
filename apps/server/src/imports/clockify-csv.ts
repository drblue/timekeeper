import { maxClockifyRows } from '@timekeeper/contracts';
import type { ClockifySource } from '@timekeeper/contracts';
import { ApiRequestError } from '../api-error.ts';

const sourceFields = {
	Project: 'project',
	Client: 'client',
	Description: 'description',
	Task: 'task',
	User: 'user',
	Group: 'group',
	Email: 'email',
	Tags: 'tags',
	'Start Date': 'startDate',
	'Start Time': 'startTime',
	'End Date': 'endDate',
	'End Time': 'endTime',
	'Duration (h)': 'durationH',
	'Duration (decimal)': 'durationDecimal',
	'Date of creation': 'dateOfCreation',
} as const satisfies Record<string, keyof ClockifySource>;

const headers = new Map<string, keyof ClockifySource>(Object.entries(sourceFields));
const maxFieldBytes = 16 * 1024;

interface ClockifyCsvRow {
	line: number;
	source: ClockifySource | null;
}

function malformed(line: number): never {
	throw new ApiRequestError(422, 'CLOCKIFY_MALFORMED_CSV', `Check CSV quoting on line ${line}.`);
}

function fieldTooLarge(line: number): never {
	throw new ApiRequestError(422, 'CLOCKIFY_CSV_LIMIT', `A CSV field exceeds the supported size on line ${line}.`);
}

function* csvRecords(text: string) {
	let position = 0;
	let line = 1;
	while (position < text.length) {
		const recordLine = line;
		const recordStart = position;
		const fields: string[] = [];
		while (true) {
			let value: string;
			const fieldStart = position;
			if (text[position] === '"') {
				position += 1;
				let start = position;
				const pieces: string[] = [];
				while (true) {
					const current = text[position];
					if (current === undefined) malformed(recordLine);
					if (current === '"') {
						pieces.push(text.slice(start, position));
						position += 1;
						if (text[position] !== '"') break;
						pieces.push('"');
						start = ++position;
					} else {
						if (current === '\n') line += 1;
						position += 1;
					}
					if (position - fieldStart > 2 * maxFieldBytes + 1) fieldTooLarge(recordLine);
				}
				value = pieces.join('');
			} else {
				const start = position;
				while (position < text.length) {
					const current = text[position];
					if (current === ',' || current === '\n' || current === '\r') break;
					if (current === '"') malformed(recordLine);
					position += 1;
					if (position - start > maxFieldBytes) fieldTooLarge(recordLine);
				}
				value = text.slice(start, position);
			}
			if (Buffer.byteLength(value) > maxFieldBytes) fieldTooLarge(recordLine);
			// Retain one extra field so unsupported row widths remain distinguishable.
			if (fields.length <= headers.size) fields.push(value);
			if (text[position] !== ',') break;
			position += 1;
		}
		const emptyLine = position === recordStart;
		if (text[position] === '\r' && text[position + 1] === '\n') position += 1;
		if (text[position] === '\n') {
			position += 1;
			line += 1;
		} else if (position !== text.length) malformed(recordLine);
		if (!emptyLine) yield { line: recordLine, fields };
	}
}

export function parseClockifyCsv(bytes: Buffer): ClockifyCsvRow[] {
	let text: string;
	try {
		text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	} catch {
		throw new ApiRequestError(422, 'CLOCKIFY_INVALID_ENCODING', 'Save the Clockify CSV as UTF-8 and upload it again.');
	}
	if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text)) {
		throw new ApiRequestError(422, 'CLOCKIFY_MALFORMED_CSV', 'The Clockify CSV contains unsupported control characters.');
	}

	const rows: ClockifyCsvRow[] = [];
	let columns: Map<keyof ClockifySource, number> | undefined;
	for (const { line, fields } of csvRecords(text)) {
		if (!columns) {
			columns = new Map();
			for (const [index, header] of fields.entries()) {
				const field = headers.get(header);
				if (field && !columns.has(field)) columns.set(field, index);
			}
			if (fields.length !== headers.size || columns.size !== headers.size) {
				throw new ApiRequestError(422, 'CLOCKIFY_UNSUPPORTED_HEADERS', 'Use a Clockify detailed CSV export with the supported named columns.');
			}
			continue;
		}
		if (rows.length >= maxClockifyRows) {
			throw new ApiRequestError(422, 'CLOCKIFY_CSV_LIMIT', `Upload a CSV with at most ${maxClockifyRows} records.`);
		}
		const source = fields.length === headers.size
			? Object.fromEntries([...columns].map(([field, index]) => [field, fields[index]!])) as ClockifySource
			: null;
		rows.push({ line, source });
	}
	if (!rows.length) {
		throw new ApiRequestError(422, 'CLOCKIFY_EMPTY_CSV', 'The Clockify CSV contains no work rows.');
	}
	return rows;
}
