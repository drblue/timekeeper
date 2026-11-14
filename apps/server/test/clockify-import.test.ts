import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
	authSessionPath, bulkEntryCommitPath, bulkEntryPreviewPath, clockifyCommitPath, clockifyPreviewPath, clockifyReviewPath, clockifyStagePath,
	csrfHeader, entriesPath, idempotencyKeyHeader, maxClockifyCsvBytes, maxClockifyRows, parseAuthSessionResponse, parseClockifyPreviewResponse,
	parseClockifyImportCommitResponse, parseClockifyImportReviewResponse, parseClockifyStageResponse,
} from '@timekeeper/contracts';
import type { ClockifyImportReviewBody } from '@timekeeper/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { openDatabase } from '../src/auth/database.ts';
import { createAuthStore, randomToken } from '../src/auth/store.ts';
import { createEntryStore } from '../src/entries/store.ts';
import { createClockifyImportStore } from '../src/imports/clockify-store.ts';
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

describe('Clockify mapping and import', () => {
	let directory: string;
	let database: Awaited<ReturnType<typeof openDatabase>>;
	let app: Awaited<ReturnType<typeof createApp>>;
	let auth: { cookies: Record<string, string>; headers: Record<string, string> };
	let accountId: string;
	let now: Date;

	const historicalBilling = { mode: 'billable', rateOrePerHour: '80001' } as const;
	const newAssociation = {
		client: { mode: 'create', name: 'Example client' }, project: { mode: 'create', name: 'Synthetic project' },
	} as const;
	const noAssociation = { client: { mode: 'none' }, project: { mode: 'none' } } as const;
	const defaults = { association: newAssociation, billing: historicalBilling };

	async function session(id: string) {
		const token = randomToken();
		await database.session.create({
			data: { accountId: id, tokenHash: createHash('sha256').update(token).digest('hex'), expiresAt: new Date(Date.now() + 300_000) },
		});
		const cookies = { '__Host-timekeeper-session': token };
		const { csrfToken } = parseAuthSessionResponse((await app.inject({ url: authSessionPath, cookies })).json());
		return { cookies, headers: { origin, [csrfHeader]: csrfToken } };
	}

	beforeAll(async () => {
		directory = await mkdtemp(join(tmpdir(), 'timekeeper-clockify-commit-test-'));
		const filename = pathToFileURL(join(directory, 'test.sqlite')).href;
		execFileSync('npm', ['run', 'db:migrate'], {
			env: { ...process.env, TIMEKEEPER_DATABASE_URL: filename }, stdio: 'pipe',
		});
		database = await openDatabase(filename);
		accountId = randomUUID();
		await database.account.create({ data: { id: accountId, email: 'owner@example.test', passwordHash: 'unused' } });
		app = await createApp({
			auth: { config: { origin, trustedProxyAddresses: new Set() }, store: await createAuthStore(database) },
			entries: createEntryStore(database, () => now),
			clockifyImport: createClockifyImportStore(database, () => now),
		});
		auth = await session(accountId);
	});

	beforeEach(async () => {
		now = new Date('2026-11-14T12:00:00.000Z');
		await database.clockifyImportStage.deleteMany();
		await database.clockifyImportIdentity.deleteMany();
		await database.clockifyImportBatch.deleteMany();
		await database.operationReceipt.deleteMany();
		await database.bulkEntryPreview.deleteMany();
		await database.entryHistory.deleteMany();
		await database.entryDayAllocation.deleteMany();
		await database.entry.deleteMany({ where: { splitFromEntryId: { not: null } } });
		await database.entry.deleteMany();
		await database.project.deleteMany();
		await database.client.deleteMany();
	});

	afterAll(async () => {
		await app?.close();
		await database?.$disconnect();
		await rm(directory, { recursive: true, force: true });
	});

	async function stage(rows: Partial<Record<Header, string>>[], headersToUse: readonly Header[] = headers) {
		const response = await app.inject({
			...auth, method: 'POST', url: clockifyStagePath,
			headers: { ...auth.headers, 'content-type': 'text/csv' }, payload: Buffer.from(csv(rows, headersToUse)),
		});
		expect(response.statusCode, response.body.slice(0, 300)).toBe(200);
		return parseClockifyStageResponse(response.json());
	}

	function request(url: string, payload: object, key?: string) {
		return app.inject({ ...auth, url, method: 'POST',
			headers: { ...auth.headers, ...(key ? { [idempotencyKeyHeader]: key } : {}) }, payload,
		});
	}

	async function review(input: ClockifyImportReviewBody) {
		const response = await request(clockifyReviewPath, input);
		expect(response.statusCode, response.body.slice(0, 300)).toBe(200);
		return parseClockifyImportReviewResponse(response.json());
	}

	async function commit(previewToken: string | null, key = randomUUID()) {
		expect(previewToken).not.toBeNull();
		return request(clockifyCommitPath, { previewToken }, key);
	}

	function sampleRows() {
		return Array.from({ length: 29 }, (_, index) => {
			const day = String(index + 1).padStart(2, '0') + '/01/2026';
			return {
				Description: 'Exempelarbete ' + (index + 1), Tags: index < 12 ? 'internal, invoiced' : '',
				'Start Date': day, 'End Date': day, 'Date of creation': day,
			};
		});
	}

	it('imports 29 reviewed rows with historical rates and 12 initial invoice marks, then skips reordered, overlapping and deleted work', async () => {
		const records = sampleRows();
		const staged = await stage(records);
		const approved = await review({ stageId: staged.stageId, defaults, rows: [] });
		expect(approved).toMatchObject({
			canCommit: true, counts: { new: 29, invoiced: 12, incomplete: 0 },
			createClients: [{ name: 'Example client' }], createProjects: [{ name: 'Synthetic project', clientName: 'Example client' }],
		});
		expect(approved.rows[0]?.approved).toMatchObject({ clientName: 'Example client', projectName: 'Synthetic project',
			billable: true, rateOrePerHour: '80001', durationSeconds: 3_723, amountOre: '82734', kind: 'timed' });
		expect(await database.entry.count()).toBe(0);
		const key = randomUUID();
		const applied = await commit(approved.previewToken, key);
		expect(applied.statusCode, applied.body).toBe(200);
		const outcome = parseClockifyImportCommitResponse(applied.json());
		expect(outcome).toMatchObject({ createdCount: 29, invoicedCount: 12, alreadyImportedCount: 0, incompleteCount: 0 });
		expect((await commit(approved.previewToken, key)).json()).toEqual(outcome);
		expect((await commit(approved.previewToken)).json()).toMatchObject({ code: 'CLOCKIFY_PREVIEW_CHANGED' });
		expect(await database.entry.count()).toBe(29);
		expect(await database.entry.count({ where: { invoicedAt: now, invoiceNumber: null, invoiceDate: null } })).toBe(12);
		expect(await database.entryDayAllocation.count()).toBe(29);
		expect(await database.entryHistory.count({ where: { action: 'created', operationKey: key } })).toBe(29);
		expect(await database.clockifyImportIdentity.count({ where: { batchId: outcome.batchId! } })).toBe(29);
		const savedClient = await database.client.findFirstOrThrow();
		const savedProject = await database.project.findFirstOrThrow();
		expect(savedClient.defaultRateOrePerHour).toBeNull();
		expect(savedProject.rateOverrideOrePerHour).toBeNull();
		const claim = await database.clockifyImportIdentity.findFirstOrThrow({ where: { entry: { localDate: '2026-01-29' } } });
		expect(JSON.parse(claim.sourceSnapshot)).toMatchObject({ source: { description: 'Exempelarbete 29', durationH: '01:02:03', task: '' } });
		await database.entry.update({ where: { id: claim.entryId }, data: { description: 'Locally edited', revision: { increment: 1 } } });
		const trashed = await request(`${entriesPath}/${claim.entryId}/delete`, { revision: 2 });
		expect(trashed.statusCode, trashed.body).toBe(200);

		const repeated = await stage([...records].reverse(), [...headers].reverse());
		const repeatReview = await review({ stageId: repeated.stageId, rows: [] });
		expect(repeatReview).toMatchObject({ canCommit: true, counts: { new: 0, alreadyImported: 29 } });
		expect((await commit(repeatReview.previewToken)).json()).toMatchObject({ batchId: null, createdCount: 0, alreadyImportedCount: 29 });
		expect(await database.entry.count()).toBe(29);
		expect(await database.entry.count({ where: { id: claim.entryId, deletedAt: { not: null } } })).toBe(1);

		const overlapping = await stage([...records.slice(-3), { Description: 'A new February record' }]);
		const overlapReview = await review({
			stageId: overlapping.stageId,
			defaults: { billing: historicalBilling, association: {
				client: { mode: 'existing', id: savedClient.id, revision: savedClient.revision },
				project: { mode: 'existing', id: savedProject.id, revision: savedProject.revision },
			} },
			rows: [],
		});
		expect(overlapReview.counts).toMatchObject({ new: 1, alreadyImported: 3 });
		expect((await commit(overlapReview.previewToken)).json()).toMatchObject({ createdCount: 1, alreadyImportedCount: 3 });
	});

	it('retains the original claim after an imported cross-midnight entry is split', async () => {
		const records = [{ 'Start Date': '11/11/2026', 'Start Time': '23:30:00', 'End Date': '12/11/2026',
			'End Time': '00:30:00', 'Duration (h)': '01:00:00' }];
		const staged = await stage(records);
		const approved = await review({ stageId: staged.stageId, defaults, rows: [] });
		expect((await commit(approved.previewToken)).statusCode).toBe(200);
		const identity = await database.clockifyImportIdentity.findFirstOrThrow();
		const split = await request(bulkEntryPreviewPath, {
			action: 'mark-invoiced', splitOutsideRange: true,
			filters: { from: '2026-11-11', to: '2026-11-11' },
			selection: { mode: 'explicit', entryIds: [identity.entryId] },
		});
		expect(split.statusCode, split.body).toBe(200);
		expect((await request(bulkEntryCommitPath, { previewToken: split.json().previewToken }, randomUUID())).statusCode).toBe(200);
		expect(await database.entry.count({ where: { splitFromEntryId: identity.entryId } })).toBe(2);
		const repeated = await stage(records);
		const repeatReview = await review({ stageId: repeated.stageId, rows: [] });
		expect(repeatReview.counts).toMatchObject({ new: 0, alreadyImported: 1 });
		expect((await commit(repeatReview.previewToken)).json()).toMatchObject({ createdCount: 0, alreadyImportedCount: 1 });
	});

	it('requires approval of folds, mismatch, missing rates and exclusions while preserving zero and invoiced incomplete work', async () => {
		const staged = await stage([
			{ Description: '   ', Tags: 'invoiced' },
			{ Description: 'Mismatch', 'Start Date': '25/10/2026', 'Start Time': '02:15:00', 'End Date': '25/10/2026',
				'End Time': '03:15:00', 'Duration (h)': '00:30:00' },
			{ Description: 'Malformed', 'Start Date': '29/02/2026' },
		]);
		const base = { stageId: staged.stageId, defaults: { association: noAssociation, billing: { mode: 'billable', rateOrePerHour: null } as const } };
		const unresolved = await review({ ...base, rows: [] });
		expect(unresolved).toMatchObject({ canCommit: false, previewToken: null, counts: { blocked: 3 },
			rows: [{ issues: ['incomplete-not-approved'] }, { issues: ['ambiguous-start'] }, { issues: ['invalid-source'] }] });
		const approved = await review({ ...base, rows: [
			{ line: 2, acceptIncomplete: true },
			{ line: 3, startOccurrence: 'later', durationChoice: 'duration-only', billing: { mode: 'billable', rateOrePerHour: '0' } },
			{ line: 4, exclude: true },
		] });
		expect(approved.counts).toMatchObject({ new: 2, incomplete: 1, invoiced: 1, excluded: 1 });
		expect(approved.rows[1]?.approved).toMatchObject({ kind: 'duration-only', durationSeconds: 1_800, amountOre: '0', rateOrePerHour: '0' });
		expect((await commit(approved.previewToken)).statusCode).toBe(200);
		const entries = await database.entry.findMany({ orderBy: { localDate: 'asc' } });
		expect(entries[0]).toMatchObject({ completion: 'incomplete', invoicedAt: now, assignedRateOrePerHour: null });
		expect(entries[1]).toMatchObject({ kind: 'duration-only', durationSeconds: 1_800, assignedRateOrePerHour: 0n });
		expect(await database.entryDayAllocation.count()).toBe(1);
		const unmarked = await request(`${entriesPath}/${entries[0]!.id}/uninvoice`, { revision: entries[0]!.revision });
		expect(unmarked.statusCode, unmarked.body).toBe(200);

		const changedChoice = await review({ ...base, rows: [
			{ line: 2, exclude: true }, { line: 3, startOccurrence: 'later', durationChoice: 'use-timestamps' }, { line: 4, exclude: true },
		] });
		expect(changedChoice.rows[1]?.status).toBe('already-imported');
	});

	it('blocks in-file identical rows and possible corrections until explicitly excluded', async () => {
		const duplicates = await stage([{}, {}]);
		const duplicateReview = await review({ stageId: duplicates.stageId, defaults, rows: [] });
		expect(duplicateReview.rows.map(({ issues }) => issues)).toEqual([['duplicate-source'], ['duplicate-source']]);
		const one = await review({ stageId: duplicates.stageId, defaults, rows: [{ line: 3, exclude: true }] });
		expect(one.counts).toMatchObject({ new: 1, excluded: 1 });
		expect((await commit(one.previewToken)).statusCode).toBe(200);
		const corrections = await stage([{ Description: 'Corrected source description' }, {}]);
		const correctionReview = await review({ stageId: corrections.stageId, rows: [] });
		expect(correctionReview).toMatchObject({ canCommit: false, rows: [
			{ status: 'blocked', issues: ['possible-correction'] }, { status: 'already-imported' },
		] });
		expect(await database.entry.count()).toBe(1);
	});

	it('rechecks catalog revisions and atomically rolls back a failure before admitting a single concurrent commit', async () => {
		const client = await database.client.create({ data: {
			id: randomUUID(), accountId, name: 'Existing client', defaultRateOrePerHour: 90000n,
		} });
		const records = sampleRows().slice(0, 3);
		const staged = await stage(records);
		const existingDefaults = { billing: historicalBilling, association: {
			client: { mode: 'existing', id: client.id, revision: client.revision }, project: newAssociation.project,
		} } as const;
		const initial = await review({ stageId: staged.stageId, defaults: existingDefaults, rows: [] });
		await database.client.update({ where: { id: client.id }, data: { revision: { increment: 1 }, name: 'Renamed client' } });
		const stale = await commit(initial.previewToken);
		expect(stale.statusCode).toBe(409);
		expect(stale.json()).toMatchObject({ code: 'CLOCKIFY_PREVIEW_CHANGED' });
		expect(await database.project.count()).toBe(0);

		const fresh = await review({ stageId: staged.stageId, defaults: {
			...existingDefaults, association: { ...existingDefaults.association, client: { ...existingDefaults.association.client, revision: 2 } },
		}, rows: [] });
		await database.$executeRaw`CREATE TRIGGER "test_clockify_fail_identity" BEFORE INSERT ON "ClockifyImportIdentity"
			WHEN (SELECT COUNT(*) FROM "ClockifyImportIdentity") > 0 BEGIN SELECT RAISE(ABORT, 'Test Clockify identity failure'); END`;
		const key = randomUUID();
		try {
			const failed = await commit(fresh.previewToken, key);
			expect(failed.statusCode).toBe(500);
			expect(await database.entry.count()).toBe(0);
			expect(await database.project.count()).toBe(0);
			expect(await database.entryDayAllocation.count()).toBe(0);
			expect(await database.entryHistory.count()).toBe(0);
			expect(await database.clockifyImportIdentity.count()).toBe(0);
			expect(await database.clockifyImportBatch.count()).toBe(0);
			expect(await database.operationReceipt.count()).toBe(0);
		} finally {
			await database.$executeRaw`DROP TRIGGER "test_clockify_fail_identity"`;
		}
		const competingStage = await stage(records);
		const competing = await review({ stageId: competingStage.stageId, defaults, rows: [] });
		const results = await Promise.all([commit(fresh.previewToken, key), commit(competing.previewToken)]);
		expect(results.map(({ statusCode }) => statusCode).sort()).toEqual([200, 409]);
		expect(await database.entry.count()).toBe(3);
		expect(await database.clockifyImportIdentity.count()).toBe(3);
		expect(await database.operationReceipt.count()).toBe(1);
		expect((await database.client.findUniqueOrThrow({ where: { id: client.id } })).defaultRateOrePerHour).toBe(90000n);
	});

	it('identifies same-name mappings in the review and rejects an excessive allocation plan', async () => {
		const clients = await Promise.all([1, 2].map(() => database.client.create({
			data: { id: randomUUID(), accountId, name: 'Shared name' },
		})));
		const staged = await stage(sampleRows().slice(0, 2));
		const approved = await review({ stageId: staged.stageId, defaults: { billing: historicalBilling },
			rows: clients.map(({ id, revision }, index) => ({
				line: index + 2,
				association: { client: { mode: 'existing', id, revision }, project: newAssociation.project },
			})),
		});
		expect(approved.rows.map(({ approved: target }) => target?.clientId)).toEqual(clients.map(({ id }) => id));
		expect(approved.createProjects).toEqual(clients.map(({ id }) => ({
			clientId: id, clientName: 'Shared name', name: newAssociation.project.name,
		})));
		expect((await commit(approved.previewToken)).statusCode).toBe(200);

		const long = await stage([{ 'Start Date': '01/01/2000', 'End Date': '01/01/2026' }]);
		const response = await request(clockifyReviewPath, {
			stageId: long.stageId, defaults: { association: noAssociation, billing: historicalBilling },
			rows: [{ line: 2, durationChoice: 'use-timestamps' }],
		});
		expect(response.statusCode, response.body).toBe(422);
		expect(response.json()).toMatchObject({ code: 'CLOCKIFY_IMPORT_TOO_LARGE' });
		expect(await database.entry.count()).toBe(2);
	});

	it('enforces owner scope, stage expiry and durable replay after pruning a consumed stage', async () => {
		const staged = await stage([{}]);
		const input = { stageId: staged.stageId, defaults, rows: [] };
		const approved = await review(input);
		const otherAccount = randomUUID();
		await database.$executeRaw`PRAGMA ignore_check_constraints = ON`;
		try {
			await database.account.create({ data: { id: otherAccount, ownerSlot: 2, email: 'other@example.test', passwordHash: 'unused' } });
		} finally {
			await database.$executeRaw`PRAGMA ignore_check_constraints = OFF`;
		}
		const other = await session(otherAccount);
		const foreign = await app.inject({ ...other, method: 'POST', url: clockifyReviewPath, payload: input });
		expect(foreign.statusCode).toBe(404);
		expect((await app.inject({ ...other, method: 'POST', url: clockifyCommitPath,
			headers: { ...other.headers, [idempotencyKeyHeader]: randomUUID() }, payload: { previewToken: approved.previewToken },
		})).statusCode).toBe(409);
		const key = randomUUID();
		const result = await commit(approved.previewToken, key);
		expect(result.statusCode).toBe(200);
		now = new Date(now.getTime() + 31 * 60_000);
		expect((await request(clockifyReviewPath, input)).json()).toMatchObject({ code: 'CLOCKIFY_STAGE_EXPIRED' });
		await stage([{}]);
		expect(await database.clockifyImportStage.count()).toBe(1);
		expect(await database.clockifyImportPreview.count()).toBe(0);
		expect((await commit(approved.previewToken, key)).json()).toEqual(result.json());
	});
});
