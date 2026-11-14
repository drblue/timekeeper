import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
	authSessionPath, clockifyPreviewPath, csrfHeader, maxClockifyCsvBytes, maxClockifyRows, parseAuthSessionResponse, parseClockifyPreviewResponse,
} from '@timekeeper/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { openDatabase } from '../src/auth/database.ts';
import { createAuthStore, randomToken } from '../src/auth/store.ts';
import { previewClockify } from '../src/imports/clockify-preview.ts';

const origin = 'https://timekeeper.example.test';
const headers = [
	'Project', 'Client', 'Description', 'Task', 'User', 'Group', 'Email', 'Tags', 'Start Date', 'Start Time',
	'End Date', 'End Time', 'Duration (h)', 'Duration (decimal)', 'Date of creation',
] as const;
type Header = typeof headers[number];

const source = {
	Project: 'Synthetic project',
	Client: 'Example client',
	Description: 'Granskning',
	Task: '',
	User: 'Example owner',
	Group: '',
	Email: 'owner@example.test',
	Tags: '',
	'Start Date': '29/02/2024',
	'Start Time': '08:04:05',
	'End Date': '29/02/2024',
	'End Time': '09:06:08',
	'Duration (h)': '01:02:03',
	'Duration (decimal)': '1.03',
	'Date of creation': '29/02/2024',
} satisfies Record<Header, string>;

function record(values: readonly string[]) {
	return values.map((value) => /[",\r\n]/.test(value) ? '"' + value.replaceAll('"', '""') + '"' : value).join(',');
}

function csv(rows: Partial<Record<Header, string>>[], columns: readonly Header[] = headers, eol = '\n') {
	return [record(columns), ...rows.map((row) => record(columns.map((column) => row[column] ?? source[column])))].join(eol);
}

describe('Clockify source inspection', () => {
	it('accepts BOM, reordered named columns, UTF-8, quoted multiline data and original blanks', () => {
		const description = '  =EXAMPLE("åäö",1)\r\nSecond line  ';
		const encoded = Buffer.from('\uFEFF' + csv([
			{ Description: description, Task: ' ', Tags: 'review, Invoiced , invoiced-later' },
			{ Description: 'Next row', Tags: 'pre-invoiced, invoiced-later', 'Date of creation': '' },
		], [...headers].reverse(), '\r\n') + '\r\n\r\n');
		const result = previewClockify(encoded, {});
		expect(result).toMatchObject({
			sourceTimeZone: 'Europe/Stockholm', requiresUserSelection: false,
			counts: { total: 2, selected: 2, valid: 2, review: 0, invalid: 0, unassigned: 0 },
			rows: [
				{ line: 2, durationSeconds: 3_723, timestampDurationSeconds: 3_723, invoicedTag: true,
					source: { description, task: ' ', group: '', durationH: '01:02:03', durationDecimal: '1.03', tags: 'review, Invoiced , invoiced-later' },
					start: { local: '2024-02-29T08:04:05', candidates: [{ instant: '2024-02-29T07:04:05.000Z', occurrence: null, offset: '+01:00' }] } },
				{ line: 4, invoicedTag: false, source: { dateOfCreation: '' } },
			],
		});
		expect(result.selectedUserId).toBe(result.users[0]?.id);
	});

	it('requires a selection for multiple users and always reports unassigned malformed rows', () => {
		const file = Buffer.from(csv([
			{ User: 'Same name', Email: 'first@example.test', Description: 'First' },
			{ User: 'Same name', Email: 'second@example.test', Description: 'Second' },
			{ User: '', Email: ' ', Description: 'Missing owner' },
			{ User: 'Same name', Email: 'second@example.test', Description: 'Third' },
		]) + '\nshort,row\n');
		const pending = previewClockify(file, {});
		expect(pending).toMatchObject({
			selectedUserId: null, requiresUserSelection: true, counts: { total: 5, selected: 0, invalid: 2, unassigned: 2 },
			users: [{ email: 'first@example.test', rowCount: 1 }, { email: 'second@example.test', rowCount: 2 }],
			rows: [{ line: 4, issues: ['missing-user'] }, { line: 6, issues: ['column-count'], source: null, invoicedTag: null }],
		});
		const selectedUserId = pending.users[1]!.id;
		const selected = previewClockify(file, { selectedUserId });
		expect(selected).toMatchObject({
			selectedUserId, requiresUserSelection: false, counts: { total: 5, selected: 2, valid: 2, invalid: 2, unassigned: 2 },
		});
		expect(selected.rows.map(({ source }) => source?.description)).toEqual(['Second', 'Missing owner', 'Third', undefined]);
		expect(() => previewClockify(file, { selectedUserId: 'a'.repeat(64) })).toThrow(expect.objectContaining({ code: 'CLOCKIFY_UNKNOWN_USER' }));
	});

	it('exposes fold choices, gaps, Gregorian errors and disagreement with the exact duration', () => {
		const file = Buffer.from(csv([
			{ 'Start Date': '25/10/2026', 'End Date': '25/10/2026', 'Start Time': '02:15:00', 'End Time': '03:15:00', 'Duration (h)': '01:00:00' },
			{ 'Start Date': '29/03/2026', 'End Date': '29/03/2026', 'Start Time': '02:15:00', 'End Time': '03:15:00', 'Duration (h)': '01:00:00' },
			{ 'Start Date': '29/02/2025', 'End Time': '24:00:00', 'Duration (h)': '01:00:60' },
			{ Description: '   ', 'Duration (h)': '00:58:33' },
			{ 'End Time': '08:04:05' },
		]));
		const local = previewClockify(file, {});
		expect(local.counts).toEqual({ total: 5, selected: 5, valid: 0, review: 2, invalid: 3, unassigned: 0 });
		expect(local.rows).toMatchObject([
			{ status: 'review', issues: ['ambiguous-start'], timestampDurationSeconds: null, start: {
				status: 'ambiguous', candidates: [
					{ occurrence: 'earlier', instant: '2026-10-25T00:15:00.000Z', offset: '+02:00' },
					{ occurrence: 'later', instant: '2026-10-25T01:15:00.000Z', offset: '+01:00' },
				],
			} },
			{ status: 'invalid', issues: ['nonexistent-start'], start: { status: 'nonexistent', candidates: [] } },
			{ status: 'invalid', issues: ['invalid-duration', 'invalid-start', 'invalid-end'] },
			{ status: 'review', issues: ['missing-description', 'duration-mismatch'], durationSeconds: 3_513, timestampDurationSeconds: 3_723 },
			{ status: 'invalid', issues: ['nonpositive-interval'], timestampDurationSeconds: 0 },
		]);
		const utc = previewClockify(file, { sourceTimeZone: 'UTC' });
		expect(utc.rows[0]).toMatchObject({ status: 'valid', start: { candidates: [{ instant: '2026-10-25T02:15:00.000Z', offset: '+00:00' }] } });
		expect(utc.rows[1]?.status).toBe('valid');
		expect(() => previewClockify(file, { sourceTimeZone: '+01:00' })).toThrow(expect.objectContaining({ code: 'CLOCKIFY_INVALID_TIME_ZONE' }));
		expect(() => previewClockify(file, { sourceTimeZone: 'Never/Exists' })).toThrow(expect.objectContaining({ code: 'CLOCKIFY_INVALID_TIME_ZONE' }));
	});

	it('rejects invalid UTF-8, unsupported layout, unclosed quotes, header-only and excess records or field size', () => {
		const valid = Buffer.from(csv([{}]));
		const invalid: [Buffer, string][] = [
			[Buffer.concat([valid, Buffer.from([0xC3, 0x28])]), 'CLOCKIFY_INVALID_ENCODING'],
			[Buffer.from('Project;Client;Description\nExample;Example;Example'), 'CLOCKIFY_UNSUPPORTED_HEADERS'],
			[Buffer.from(headers.map((header) => header === 'Task' ? 'User' : header).join(',') + '\nrow'), 'CLOCKIFY_UNSUPPORTED_HEADERS'],
			[Buffer.from(record(headers) + '\n"unclosed'), 'CLOCKIFY_MALFORMED_CSV'],
			[Buffer.from(csv([{ Description: '\u0000' }])), 'CLOCKIFY_MALFORMED_CSV'],
			[Buffer.from(record(headers) + '\n"closed"junk'), 'CLOCKIFY_MALFORMED_CSV'],
			[Buffer.from(record(headers) + '\r\n'), 'CLOCKIFY_EMPTY_CSV'],
			[Buffer.from(csv(Array.from({ length: maxClockifyRows + 1 }, () => ({})))), 'CLOCKIFY_CSV_LIMIT'],
			[Buffer.from(csv([{ Description: 'ö'.repeat(8_193) }])), 'CLOCKIFY_CSV_LIMIT'],
		];
		for (const [bytes, code] of invalid) {
			expect(() => previewClockify(bytes, {})).toThrow(expect.objectContaining({ code }));
		}
	});
});

describe('Clockify upload API', () => {
	let directory: string;
	let database: Awaited<ReturnType<typeof openDatabase>>;
	let app: Awaited<ReturnType<typeof createApp>>;
	let auth: { cookies: Record<string, string>; headers: Record<string, string> };

	beforeAll(async () => {
		directory = await mkdtemp(join(tmpdir(), 'timekeeper-clockify-test-'));
		const filename = pathToFileURL(join(directory, 'test.sqlite')).href;
		execFileSync('npm', ['run', 'db:migrate'], {
			env: { ...process.env, TIMEKEEPER_DATABASE_URL: filename },
			stdio: 'pipe',
		});
		database = await openDatabase(filename);
		const accountId = randomUUID();
		await database.account.create({ data: { id: accountId, email: 'owner@example.test', passwordHash: 'unused' } });
		const token = randomToken();
		await database.session.create({
			data: { accountId, tokenHash: createHash('sha256').update(token).digest('hex'), expiresAt: new Date(Date.now() + 60_000) },
		});
		app = await createApp({ auth: { config: { origin, trustedProxyAddresses: new Set() }, store: await createAuthStore(database) } });
		const cookies = { '__Host-timekeeper-session': token };
		const { csrfToken } = parseAuthSessionResponse((await app.inject({ url: authSessionPath, cookies })).json());
		auth = { cookies, headers: { origin, [csrfHeader]: csrfToken, 'content-type': 'text/csv; charset=UTF-8' } };
	});

	afterAll(async () => {
		await app?.close();
		await database?.$disconnect();
		await rm(directory, { recursive: true, force: true });
	});

	it('requires authentication and CSRF and returns a private stateless preview', async () => {
		const request = { method: 'POST', url: clockifyPreviewPath + '?sourceTimeZone=UTC', payload: Buffer.from(csv([{}])) } as const;
		expect((await app.inject(request)).statusCode).toBe(401);
		expect((await app.inject({ ...request, cookies: auth.cookies, headers: { 'content-type': 'text/csv', origin } })).statusCode).toBe(403);
		const first = await app.inject({ ...request, ...auth });
		expect(first.statusCode, first.body).toBe(200);
		expect(first.headers['cache-control']).toBe('no-store');
		expect(parseClockifyPreviewResponse(first.json())).toMatchObject({ sourceTimeZone: 'UTC', counts: { selected: 1, valid: 1 } });
		expect((await app.inject({ ...request, ...auth })).json()).toEqual(first.json());
		expect((await app.inject({ ...request, ...auth, url: clockifyPreviewPath + '?unknown=true' })).statusCode).toBe(400);
		expect(await database.entry.count()).toBe(0);
		expect(await database.entryHistory.count()).toBe(0);
		expect(await database.client.count()).toBe(0);
		expect(await database.project.count()).toBe(0);
		expect(await database.operationReceipt.count()).toBe(0);
	});

	it('rejects other media types, oversized uploads and empty files before mutation', async () => {
		const request = { ...auth, method: 'POST', url: clockifyPreviewPath } as const;
		const incorrect = await app.inject({ ...request, headers: { ...auth.headers, 'content-type': 'text/plain' }, payload: 'CSV' });
		expect(incorrect.statusCode).toBe(415);
		expect(incorrect.json()).toMatchObject({ code: 'CLOCKIFY_UNSUPPORTED_MEDIA_TYPE' });
		expect((await app.inject({ ...request, payload: Buffer.alloc(maxClockifyCsvBytes + 1, 65) })).statusCode).toBe(413);
		const empty = await app.inject({ ...request, payload: Buffer.alloc(0) });
		expect(empty.statusCode, empty.body).toBe(422);
		expect(empty.json()).toMatchObject({ code: 'CLOCKIFY_EMPTY_CSV' });
		expect(await database.entry.count()).toBe(0);
	});
});
