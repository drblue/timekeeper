import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';
import {
	authSessionPath,
	bulkEntryCommitPath,
	bulkEntryPreviewPath,
	clientsPath,
	csrfHeader,
	entriesPath,
	entryTrashPath,
	idempotencyKeyHeader,
	maxEntryDescriptionLength,
	maxEntryDurationSeconds,
	maxHourlyRateOre,
	maxReportLogoBytes,
	parseAuthSessionResponse,
	parseBulkEntryCommitResponse,
	parseBulkEntryPreviewResponse,
	parseEntryListResponse,
	parseEntryEditPreview,
	parseEntryHistoryResponse,
	parseEntryTrashResponse,
	parseEntryResponse,
	parseProjectResponse,
	parseReportPreviewResponse,
	parseReportSettingsResponse,
	parseTrashedEntryResponse,
	parseWorkListResponse,
	projectsPath,
	reportPreviewPath,
	reportLogoPath,
	reportSettingsPath,
	workListPath,
} from '@timekeeper/contracts';
import type { BulkEntryPreviewBody, CreateDurationEntryBody, CreateTimedEntryBody, EntryEditBody, EntryResponse, ReportPreviewQuery, WorkListQuery } from '@timekeeper/contracts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import { createApp } from '../src/app.ts';
import { openDatabase } from '../src/auth/database.ts';
import { createAuthStore, randomToken } from '../src/auth/store.ts';
import { createCatalogStore } from '../src/catalog/store.ts';
import { createEntryStore } from '../src/entries/store.ts';
import { buildReportData } from '../src/reports/report-data.ts';
import { createReportPreview } from '../src/reports/routes.ts';
import { createReportSettings } from '../src/reports/settings.ts';

const origin = 'https://timekeeper.example.test';

function work(overrides: Partial<CreateDurationEntryBody> = {}): CreateDurationEntryBody {
	return {
		kind: 'duration-only',
		description: '  Reviewed project notes  ',
		localDate: '2026-10-25',
		durationSeconds: 5_400,
		projectId: null,
		directClientId: null,
		rateOverrideOrePerHour: null,
		...overrides,
	};
}

function timed(overrides: Partial<CreateTimedEntryBody> = {}): CreateTimedEntryBody {
	return {
		kind: 'timed', description: 'Timed work', startLocal: '2026-11-11T23:30', endLocal: '2026-11-12T00:30',
		projectId: null, directClientId: null, rateOverrideOrePerHour: null, ...overrides,
	};
}

describe('Manual entries', () => {
	let fixtureDirectory: string;
	let fixtureFile: string;
	let directory: string;
	let database: Awaited<ReturnType<typeof openDatabase>>;
	let app: Awaited<ReturnType<typeof createApp>>;
	let accountId: string;
	let session: Awaited<ReturnType<typeof sessionFor>>;
	let now: string;

	beforeAll(async () => {
		fixtureDirectory = await mkdtemp(join(tmpdir(), 'timekeeper-entries-migration-'));
		fixtureFile = join(fixtureDirectory, 'test.sqlite');
		execFileSync('npm', ['run', 'db:migrate'], {
			env: { ...process.env, TIMEKEEPER_DATABASE_URL: pathToFileURL(fixtureFile).href },
			stdio: 'pipe',
		});
	});

	afterAll(async () => {
		await rm(fixtureDirectory, { recursive: true, force: true });
	});

	async function sessionFor(ownerId: string) {
		const token = randomToken();
		await database.session.create({
			data: {
				tokenHash: createHash('sha256').update(token).digest('hex'),
				accountId: ownerId,
				expiresAt: new Date(Date.now() + 60_000),
			},
		});
		const cookies = { '__Host-timekeeper-session': token };
		const response = await app.inject({ url: authSessionPath, cookies });
		const current = parseAuthSessionResponse(response.json());
		expect(current.account).not.toBeNull();
		return { cookies, headers: { origin, [csrfHeader]: current.csrfToken } };
	}

	beforeEach(async () => {
		now = '2026-11-15T23:30:00.000Z';
		directory = await mkdtemp(join(tmpdir(), 'timekeeper-entries-test-'));
		const filename = join(directory, 'test.sqlite');
		await copyFile(fixtureFile, filename);
		database = await openDatabase(pathToFileURL(filename).href);
		accountId = randomUUID();
		await database.account.create({ data: { id: accountId, email: 'owner@example.test', passwordHash: 'unused' } });
		app = await createApp({
			auth: { config: { origin, trustedProxyAddresses: new Set() }, store: await createAuthStore(database) },
			catalog: createCatalogStore(database),
			entries: createEntryStore(database, () => new Date(now)),
			reportPreview: createReportPreview(database, () => new Date(now)),
			reportSettings: createReportSettings(database),
		});
		session = await sessionFor(accountId);
	});

	afterEach(async () => {
		await app?.close();
		await database?.$disconnect();
		await rm(directory, { recursive: true, force: true });
	});

	function request(method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) {
		return app.inject({ ...session, method, url, payload });
	}

	async function readWork(query: WorkListQuery = {}) {
		const result = await request('GET', `${workListPath}?${new URLSearchParams(query)}`);
		expect(result.statusCode, result.body).toBe(200);
		expect(result.headers['cache-control']).toBe('no-store');
		return parseWorkListResponse(result.json());
	}

	async function readReport(query: ReportPreviewQuery = {}) {
		const result = await request('GET', `${reportPreviewPath}?${new URLSearchParams(query)}`);
		expect(result.statusCode, result.body).toBe(200);
		expect(result.headers['cache-control']).toBe('no-store');
		return parseReportPreviewResponse(result.json());
	}

	function putLogo(payload: Buffer, contentType = 'image/png', expected = 'none') {
		return app.inject({ ...session, method: 'PUT', url: `${reportLogoPath}?expectedLogoId=${expected}`, payload,
			headers: { ...session.headers, 'content-type': contentType } });
	}

	function png(red: number) {
		const image = new PNG({ width: 1, height: 1 });
		image.data.set([red, 30, 90, 255]);
		return PNG.sync.write(image);
	}

	async function bulkPreview(input: BulkEntryPreviewBody) {
		const result = await request('POST', bulkEntryPreviewPath, input);
		expect(result.statusCode, result.body).toBe(200);
		return parseBulkEntryPreviewResponse(result.json());
	}

	function bulkCommit(previewToken: string | null, key: string = randomUUID()) {
		return app.inject({ ...session, method: 'POST', url: bulkEntryCommitPath, payload: { previewToken },
			headers: { ...session.headers, [idempotencyKeyHeader]: key } });
	}

	async function createEntry(overrides?: Partial<CreateDurationEntryBody>) {
		const response = await request('POST', entriesPath, work(overrides));
		expect(response.statusCode, response.body).toBe(201);
		const entry = parseEntryResponse(response.json());
		if (entry.kind !== 'duration-only') throw new Error('Expected a duration-only entry');
		return entry;
	}

	async function createTimedEntry(overrides?: Partial<CreateTimedEntryBody>) {
		const response = await request('POST', entriesPath, timed(overrides));
		expect(response.statusCode, response.body).toBe(201);
		const entry = parseEntryResponse(response.json());
		if (entry.kind !== 'timed') throw new Error('Expected a timed entry');
		return entry;
	}

	function change(entry: EntryResponse, overrides: Partial<EntryEditBody> = {}): EntryEditBody {
		const { description, projectId, directClientId, billable, revision } = entry;
		return { description, projectId, directClientId, billable, revision, ...overrides };
	}

	async function addClient(name: string, rate?: bigint) {
		return database.client.create({ data: { id: randomUUID(), accountId, name, defaultRateOrePerHour: rate } });
	}

	async function addProject(clientId?: string, rate?: bigint, defaultBillable = true) {
		return database.project.create({ data: {
			id: randomUUID(), accountId, name: 'Website', clientId, rateOverrideOrePerHour: rate, defaultBillable,
		} });
	}

	it('retains 90 minutes on a local calendar date with one exact allocation and no fabricated clock times', async () => {
		const entry = await createEntry();
		expect(entry).toEqual({
			id: expect.any(String), kind: 'duration-only', description: 'Reviewed project notes',
			completion: 'complete',
			localDate: '2026-10-25', durationSeconds: 5_400, projectId: null, directClientId: null,
			clientId: null, projectName: null, clientName: null, billable: false,
			assignedRateOrePerHour: null, billableAmountOre: '0', revision: 1,
		});
		const detail = await request('GET', `${entriesPath}/${entry.id}`);
		expect(detail.statusCode).toBe(200);
		expect(detail.headers['cache-control']).toBe('no-store');
		expect(parseEntryResponse(detail.json())).toEqual(entry);
		const older = await createEntry({ localDate: '2026-10-24', durationSeconds: 1 });
		expect(parseEntryListResponse((await request('GET', entriesPath)).json())).toEqual([entry, older]);
		expect(await database.entryDayAllocation.findMany({ where: { entryId: entry.id } })).toEqual([
			{ entryId: entry.id, localDate: '2026-10-25', seconds: 5_400, amountOre: 0n, calculationVersion: 1 },
		]);
	});

	it('snapshots inherited rates for backdated work and resolves current catalog names through stable IDs', async () => {
		const client = await addClient('Client', 80_000n);
		const project = await addProject(client.id);
		const historical = await createEntry({ projectId: project.id });
		expect(historical).toMatchObject({
			projectId: project.id, directClientId: null, clientId: client.id, clientName: 'Client', projectName: 'Website',
			billable: true, assignedRateOrePerHour: '80000', billableAmountOre: '120000',
		});
		const changedClient = await request('PUT', `${clientsPath}/${client.id}`, {
			name: 'Renamed client', notes: null, defaultRateOrePerHour: '90000', revision: 1,
		});
		expect(changedClient.statusCode).toBe(200);
		const backdated = await createEntry({ projectId: project.id, localDate: '2026-02-01' });
		expect(backdated).toMatchObject({
			localDate: '2026-02-01', clientId: client.id, assignedRateOrePerHour: '90000', billableAmountOre: '135000',
		});
		const direct = await createEntry({ directClientId: client.id });
		expect(direct).toMatchObject({
			directClientId: client.id, projectId: null, clientId: client.id, billable: true,
			assignedRateOrePerHour: '90000', billableAmountOre: '135000',
		});
		const changedProject = await request('PUT', `${projectsPath}/${project.id}`, {
			clientId: client.id, name: 'Renamed project', notes: null, rateOverrideOrePerHour: '100000', defaultBillable: true, revision: 1,
		});
		expect(changedProject.statusCode).toBe(200);
		const archived = await request('POST', `${projectsPath}/${project.id}/archive`, { revision: 2 });
		expect(archived.statusCode).toBe(200);
		const detail = parseEntryResponse((await request('GET', `${entriesPath}/${historical.id}`)).json());
		expect(detail).toEqual({ ...historical, clientName: 'Renamed client', projectName: 'Renamed project' });
		expect(await database.entryDayAllocation.findMany({ where: { entryId: historical.id } })).toMatchObject([
			{ amountOre: 120_000n, localDate: historical.localDate, seconds: historical.durationSeconds },
		]);
	});

	it('honors project and entry overrides, default billability and the distinction between null and zero', async () => {
		const client = await addClient('Client', 80_000n);
		const freeProject = await addProject(client.id, 0n);
		const noRateProject = await addProject();
		const nonbillableProject = await addProject(client.id, 700n, false);
		const standaloneProject = await addProject(undefined, 700n);
		expect(await createEntry({ projectId: freeProject.id })).toMatchObject({
			billable: true, assignedRateOrePerHour: '0', billableAmountOre: '0',
		});
		expect(await createEntry({ projectId: noRateProject.id, rateOverrideOrePerHour: '0' })).toMatchObject({
			billable: true, assignedRateOrePerHour: '0', billableAmountOre: '0',
		});
		expect(await createEntry({ projectId: nonbillableProject.id })).toMatchObject({
			billable: false, assignedRateOrePerHour: '700', billableAmountOre: '0',
		});
		expect(await createEntry({ projectId: nonbillableProject.id, billable: true, rateOverrideOrePerHour: '777' })).toMatchObject({
			billable: true, assignedRateOrePerHour: '777', billableAmountOre: '1166',
		});
		expect(await createEntry({ projectId: standaloneProject.id })).toMatchObject({
			clientId: null, billable: true, assignedRateOrePerHour: '700', billableAmountOre: '1050',
		});
		const missing = await request('POST', entriesPath, work({ projectId: noRateProject.id }));
		expect(missing.statusCode).toBe(422);
		expect(missing.json()).toMatchObject({ code: 'MISSING_HOURLY_RATE' });
		expect(await database.entry.count()).toBe(5);
	});

	it('rounds exact half-öre amounts up and rejects storage overflow without a partial entry', async () => {
		for (const [durationSeconds, expected] of [[1_799, '0'], [1_800, '1'], [1_801, '1']] as const) {
			const entry = await createEntry({ durationSeconds, billable: true, rateOverrideOrePerHour: '1' });
			expect(entry.billableAmountOre).toBe(expected);
		}
		const maximum = await createEntry({ durationSeconds: 3_600, billable: true, rateOverrideOrePerHour: maxHourlyRateOre });
		expect(maximum.billableAmountOre).toBe(maxHourlyRateOre);
		expect(await database.entryDayAllocation.findMany({ where: { entryId: maximum.id } })).toMatchObject([
			{ amountOre: BigInt(maxHourlyRateOre), seconds: 3_600 },
		]);
		const overAmount = await request('POST', entriesPath, work({
			durationSeconds: 3_601, billable: true, rateOverrideOrePerHour: maxHourlyRateOre,
		}));
		expect(overAmount.statusCode).toBe(422);
		expect(overAmount.json()).toMatchObject({ code: 'AMOUNT_OUT_OF_RANGE' });
		const overRate = await request('POST', entriesPath, work({ rateOverrideOrePerHour: '9223372036854775808' }));
		expect(overRate.statusCode).toBe(422);
		expect(overRate.json()).toMatchObject({ code: 'INVALID_HOURLY_RATE' });
		expect(await createEntry({ durationSeconds: maxEntryDurationSeconds, billable: false, rateOverrideOrePerHour: maxHourlyRateOre }))
			.toMatchObject({ durationSeconds: maxEntryDurationSeconds, assignedRateOrePerHour: maxHourlyRateOre, billableAmountOre: '0' });
		expect(await database.entry.count()).toBe(5);
		expect(await database.entryDayAllocation.count()).toBe(5);
	});

	it('requires one valid association, a positive integer duration, and a real Gregorian date', async () => {
		const client = await addClient('Client');
		const project = await addProject(client.id);
		const both = await request('POST', entriesPath, work({ projectId: project.id, directClientId: client.id }));
		expect(both.statusCode).toBe(422);
		expect(both.json()).toMatchObject({ code: 'INVALID_ASSOCIATION' });
		for (const localDate of ['0000-01-01', '1900-02-29', '2026-04-31', '2026-01-00', '2026-00-05', '2026-13-05']) {
			const invalidDate = await request('POST', entriesPath, work({ localDate }));
			expect(invalidDate.statusCode).toBe(422);
			expect(invalidDate.json()).toMatchObject({ code: 'INVALID_LOCAL_DATE' });
		}
		for (const durationSeconds of [0, -1, 1.5, '60', maxEntryDurationSeconds + 1]) {
			expect((await request('POST', entriesPath, { ...work(), durationSeconds })).statusCode).toBe(400);
		}
		for (const payload of [
			{ ...work(), startAt: '2026-10-25T01:00:00.000Z' },
			work({ localDate: '2026-02-9' }),
			work({ description: '🌳'.repeat(maxEntryDescriptionLength + 1) }),
		]) {
			expect((await request('POST', entriesPath, payload)).statusCode).toBe(400);
		}
		expect((await request('POST', entriesPath, work({ description: '   ' }))).json()).toMatchObject({ code: 'INVALID_DESCRIPTION' });
		expect(await database.entry.count()).toBe(0);
		const description = '🌳'.repeat(maxEntryDescriptionLength);
		expect(await createEntry({ localDate: '2000-02-29', description })).toMatchObject({ localDate: '2000-02-29', description });
	});

	it('checks archive state and atomically prevents project reassignment after work exists', async () => {
		const oldClient = await addClient('Old', 100n);
		const newClient = await addClient('New', 200n);
		const project = await addProject(oldClient.id);
		const projectUrl = `${projectsPath}/${project.id}`;
		const updated = { clientId: newClient.id, name: project.name, notes: null, rateOverrideOrePerHour: null, defaultBillable: true, revision: 1 };
		const [entryResponse, reassignment] = await Promise.all([
			request('POST', entriesPath, work({ projectId: project.id })),
			request('PUT', projectUrl, updated),
		]);
		expect(entryResponse.statusCode, entryResponse.body).toBe(201);
		const entry = parseEntryResponse(entryResponse.json());
		const persisted = await database.project.findUniqueOrThrow({ where: { id: project.id } });
		expect(entry.clientId).toBe(persisted.clientId);
		if (reassignment.statusCode === 200) {
			expect(parseProjectResponse(reassignment.json())).toMatchObject({ clientId: newClient.id, revision: 2 });
			expect(entry.assignedRateOrePerHour).toBe('200');
		} else {
			expect(reassignment.statusCode).toBe(409);
			expect(reassignment.json()).toMatchObject({ code: 'PROJECT_CLIENT_LOCKED' });
			expect(entry.assignedRateOrePerHour).toBe('100');
		}
		const detach = await request('PUT', projectUrl, { ...updated, clientId: null, revision: persisted.revision });
		expect(detach.statusCode).toBe(409);
		expect(detach.json()).toMatchObject({
			code: 'PROJECT_CLIENT_LOCKED', fieldErrors: [{ field: 'body/clientId', message: expect.any(String) }],
		});
		const parentId = entry.clientId!;
		expect((await request('POST', `${clientsPath}/${parentId}/archive`, { revision: 1 })).statusCode).toBe(200);
		expect((await request('POST', entriesPath, work({ projectId: project.id }))).json()).toMatchObject({ code: 'INVALID_PROJECT' });
		expect((await request('POST', entriesPath, work({ directClientId: parentId }))).json()).toMatchObject({ code: 'INVALID_CLIENT' });
		const unassigned = await addProject();
		expect((await request('POST', `${projectsPath}/${unassigned.id}/archive`, { revision: 1 })).statusCode).toBe(200);
		expect((await request('POST', entriesPath, work({ projectId: unassigned.id, billable: false }))).json()).toMatchObject({ code: 'INVALID_PROJECT' });
		expect(parseEntryListResponse((await request('GET', entriesPath)).json())).toEqual([entry]);
	});

	it('enforces sessions, CSRF and ownership for entries and both kinds of related ID', async () => {
		const ownedClient = await addClient('Private client');
		const ownedProject = await addProject(ownedClient.id, 500n);
		const ownedEntry = await createEntry({ projectId: ownedProject.id });
		const ownedTimed = await createTimedEntry({ projectId: ownedProject.id });
		expect((await app.inject({ url: entriesPath })).statusCode).toBe(401);
		expect((await app.inject({ ...session, headers: { origin }, method: 'POST', url: entriesPath, payload: work() })).json())
			.toMatchObject({ code: 'CSRF_REJECTED' });
		const foreignId = randomUUID();
		// Relax the single-owner slot only while seeding the second account for this isolation test.
		await database.$executeRaw`PRAGMA ignore_check_constraints = ON`;
		try {
			await database.account.create({ data: { id: foreignId, ownerSlot: 2, email: 'other@example.test', passwordHash: 'unused' } });
		} finally {
			await database.$executeRaw`PRAGMA ignore_check_constraints = OFF`;
		}
		session = await sessionFor(foreignId);
		expect(parseEntryListResponse((await request('GET', entriesPath)).json())).toEqual([]);
		const foreignRead = await request('GET', `${entriesPath}/${ownedEntry.id}`);
		expect(foreignRead.statusCode).toBe(404);
		expect(foreignRead.json()).toMatchObject({ code: 'NOT_FOUND' });
		for (const attempted of [
			request('GET', `${entriesPath}/${ownedEntry.id}/history`),
			request('POST', `${entriesPath}/${ownedEntry.id}/edit-preview`, change(ownedEntry)),
			request('PUT', `${entriesPath}/${ownedEntry.id}`, change(ownedEntry)),
			request('POST', `${entriesPath}/${ownedEntry.id}/delete`, { revision: ownedEntry.revision }),
			request('POST', `${entriesPath}/${ownedEntry.id}/restore`, { revision: ownedEntry.revision }),
			request('POST', `${entriesPath}/${ownedEntry.id}/invoice`, { revision: ownedEntry.revision }),
			request('PUT', `${entriesPath}/${ownedEntry.id}/invoice`, { revision: ownedEntry.revision }),
			request('POST', `${entriesPath}/${ownedEntry.id}/uninvoice`, { revision: ownedEntry.revision }),
		]) expect((await attempted).statusCode).toBe(404);
		expect((await request('POST', entriesPath, work({ projectId: ownedProject.id }))).json()).toMatchObject({ code: 'INVALID_PROJECT' });
		expect((await request('POST', entriesPath, work({ directClientId: ownedClient.id }))).json()).toMatchObject({ code: 'INVALID_CLIENT' });
		const foreignEntry = await createEntry();
		const foreignTimed = await createTimedEntry();
		expect(foreignTimed.startAt).toBe(ownedTimed.startAt);
		expect(parseEntryListResponse((await request('GET', entriesPath)).json())).toEqual([foreignTimed, foreignEntry]);
		const row = await database.entry.findUniqueOrThrow({ where: { id: ownedEntry.id } });
		await expect(database.entry.create({ data: { ...row, id: randomUUID(), accountId: foreignId } })).rejects.toMatchObject({ code: 'P2003' });
		await expect(database.entry.create({ data: {
			...row, id: randomUUID(), accountId: foreignId, projectId: null, directClientId: ownedClient.id,
		} })).rejects.toMatchObject({ code: 'P2003' });
	});

	it('rolls back the entry when its allocation write fails', async () => {
		await database.$executeRaw`CREATE TRIGGER "test_reject_allocation" BEFORE INSERT ON "EntryDayAllocation"
			BEGIN SELECT RAISE(ABORT, 'Test allocation failure'); END`;
		expect((await request('POST', entriesPath, work())).statusCode).toBe(500);
		expect(await database.entry.count()).toBe(0);
		expect(await database.entryDayAllocation.count()).toBe(0);
	});

	it('stores exact UTC instants and conserves seconds and a rounded öre across midnight', async () => {
		const ordinary = await createEntry();
		const entry = await createTimedEntry({ billable: true, rateOverrideOrePerHour: '1' });
		expect(entry).toMatchObject({
			startAt: '2026-11-11T22:30:00.000Z', endAt: '2026-11-11T23:30:00.000Z',
			localDate: '2026-11-11', durationSeconds: 3_600, billableAmountOre: '1',
			allocations: [{ localDate: '2026-11-11', seconds: 1_800, amountOre: '1' }, { localDate: '2026-11-12', seconds: 1_800, amountOre: '0' }],
		});
		expect(parseEntryResponse((await request('GET', `${entriesPath}/${entry.id}`)).json())).toEqual(entry);
		expect(parseEntryListResponse((await request('GET', entriesPath)).json())).toEqual([entry, ordinary]);
		expect(await database.entryDayAllocation.findMany({ where: { entryId: entry.id }, orderBy: { localDate: 'asc' } })).toEqual([
			{ entryId: entry.id, localDate: '2026-11-11', seconds: 1_800, amountOre: 1n, calculationVersion: 1 },
			{ entryId: entry.id, localDate: '2026-11-12', seconds: 1_800, amountOre: 0n, calculationVersion: 1 },
		]);
		const untilMidnight = await createTimedEntry({ startLocal: '2026-11-13T23:59:59', endLocal: '2026-11-14T00:00:00' });
		expect(untilMidnight).toMatchObject({ durationSeconds: 1, allocations: [{ localDate: '2026-11-13', seconds: 1, amountOre: '0' }] });
	});

	it('uses actual elapsed time and Stockholm day boundaries across spring and autumn DST', async () => {
		const spring = await createTimedEntry({ startLocal: '2026-03-28T23:30', endLocal: '2026-03-30T00:30', billable: true, rateOverrideOrePerHour: '3600' });
		expect(spring).toMatchObject({
			startAt: '2026-03-28T22:30:00.000Z', endAt: '2026-03-29T22:30:00.000Z', durationSeconds: 86_400, billableAmountOre: '86400',
			allocations: [
				{ localDate: '2026-03-28', seconds: 1_800, amountOre: '1800' },
				{ localDate: '2026-03-29', seconds: 82_800, amountOre: '82800' },
				{ localDate: '2026-03-30', seconds: 1_800, amountOre: '1800' },
			],
		});
		const autumn = await createTimedEntry({ startLocal: '2026-10-24T23:30', endLocal: '2026-10-26T00:30' });
		expect(autumn).toMatchObject({
			startAt: '2026-10-24T21:30:00.000Z', endAt: '2026-10-25T23:30:00.000Z', durationSeconds: 93_600,
			allocations: [
				{ localDate: '2026-10-24', seconds: 1_800, amountOre: '0' },
				{ localDate: '2026-10-25', seconds: 90_000, amountOre: '0' },
				{ localDate: '2026-10-26', seconds: 1_800, amountOre: '0' },
			],
		});
	});

	it('requires an explicit occurrence for each repeated endpoint and rejects gaps, invalid times and nonpositive ranges', async () => {
		const repeated = { startLocal: '2026-10-25T02:45', endLocal: '2026-10-25T02:15' };
		for (const [overrides, code, field] of [
			[repeated, 'AMBIGUOUS_LOCAL_TIME', 'startOccurrence'],
			[{ ...repeated, startOccurrence: 'earlier' }, 'AMBIGUOUS_LOCAL_TIME', 'endOccurrence'],
			[{ startLocal: '2026-03-29T02:30' }, 'NONEXISTENT_LOCAL_TIME', 'startLocal'],
			[{ endLocal: '2026-03-29T02:30' }, 'NONEXISTENT_LOCAL_TIME', 'endLocal'],
			[{ startLocal: '2026-02-29T12:00' }, 'INVALID_LOCAL_TIME', 'startLocal'],
			[{ startLocal: '2026-11-11T23:59:60' }, 'INVALID_LOCAL_TIME', 'startLocal'],
			[{ startLocal: '2026-11-12T00:30' }, 'INVALID_TIME_RANGE', 'endLocal'],
			[{ startLocal: '2026-11-12T00:31' }, 'INVALID_TIME_RANGE', 'endLocal'],
			[{ startLocal: '1900-01-01T00:00' }, 'INVALID_DURATION', 'endLocal'],
		] as const) {
			const rejected = await request('POST', entriesPath, timed(overrides));
			expect(rejected.statusCode, rejected.body).toBe(422);
			expect(rejected.json()).toMatchObject({ code, fieldErrors: [{ field: `body/${field}` }] });
		}
		expect(await database.entry.count()).toBe(0);
		const entry = await createTimedEntry({ ...repeated, startOccurrence: 'earlier', endOccurrence: 'later' });
		expect(entry).toMatchObject({ startAt: '2026-10-25T00:45:00.000Z', endAt: '2026-10-25T01:15:00.000Z', durationSeconds: 1_800 });
	});

	it('warns on real half-open overlaps, accepts confirmation, and ignores duration-only work', async () => {
		await createEntry({ localDate: '2026-11-11' });
		await createTimedEntry();
		const adjacent = await createTimedEntry({ startLocal: '2026-11-12T00:30', endLocal: '2026-11-12T01:00' });
		expect(adjacent.durationSeconds).toBe(1_800);
		const overlap = timed({ startLocal: '2026-11-12T00:00', endLocal: '2026-11-12T00:31' });
		const rejected = await request('POST', entriesPath, overlap);
		expect(rejected.statusCode).toBe(409);
		expect(rejected.json()).toMatchObject({ code: 'ENTRY_OVERLAP' });
		expect(await database.entry.count()).toBe(3);
		expect(await database.entryDayAllocation.count()).toBe(4);
		await createTimedEntry({ ...overlap, confirmOverlap: true });
		expect(await database.entry.count()).toBe(4);
		const next = timed({ startLocal: '2026-11-12T14:00', endLocal: '2026-11-12T15:00' });
		const competing = await Promise.all([request('POST', entriesPath, next), request('POST', entriesPath, next)]);
		expect(competing.map(({ statusCode }) => statusCode).sort()).toEqual([201, 409]);
	});

	it('keeps the assigned rate and saved split amount for irrelevant changes, and redistributes saved total on a date move', async () => {
		const client = await addClient('Current', 80_000n);
		const source = await createEntry({ directClientId: client.id, durationSeconds: 1_800 });
		const url = `${entriesPath}/${source.id}`;
		// Model an existing split child whose preserved allocation differs from independently rounding its duration and rate.
		await database.entry.update({ where: { id: source.id }, data: { billableAmountOre: 39_999n } });
		await database.entryDayAllocation.updateMany({ where: { entryId: source.id }, data: { amountOre: 39_999n, calculationVersion: 2 } });
		await database.client.update({ where: { id: client.id }, data: { archivedAt: new Date(), defaultRateOrePerHour: 90_000n } });
		const timing = { kind: 'duration-only', localDate: source.localDate, durationSeconds: source.durationSeconds } as const;
		const noOp = await request('PUT', url, change(source, { time: timing, rate: { mode: 'override', rateOrePerHour: '80000' } }));
		expect(noOp.statusCode).toBe(200);
		expect(parseEntryResponse(noOp.json())).toMatchObject({ revision: 1, assignedRateOrePerHour: '80000', billableAmountOre: '39999' });
		expect(await database.entryHistory.count({ where: { entryId: source.id } })).toBe(1);
		const renamed = await request('PUT', url, change(source, { description: 'Corrected description' }));
		expect(renamed.statusCode).toBe(200);
		const renamedEntry = parseEntryResponse(renamed.json());
		expect(renamedEntry).toMatchObject({ revision: 2, assignedRateOrePerHour: '80000', billableAmountOre: '39999' });
		expect(await database.entryDayAllocation.findMany({ where: { entryId: source.id } })).toMatchObject([
			{ localDate: source.localDate, seconds: 1_800, amountOre: 39_999n, calculationVersion: 2 },
		]);
		const moved = change(renamedEntry, { time: { ...timing, localDate: '2026-10-26' } });
		const preview = await request('POST', `${url}/edit-preview`, moved);
		expect(preview.statusCode).toBe(200);
		expect(parseEntryEditPreview(preview.json())).toEqual({ durationSeconds: 1_800, assignedRateOrePerHour: '80000', billableAmountOre: '39999', overlap: false });
		expect((await database.entry.findUniqueOrThrow({ where: { id: source.id } })).revision).toBe(2);
		const saved = await request('PUT', url, moved);
		expect(saved.statusCode).toBe(200);
		expect(await database.entryDayAllocation.findMany({ where: { entryId: source.id } })).toMatchObject([
			{ localDate: '2026-10-26', seconds: 1_800, amountOre: 39_999n, calculationVersion: 1 },
		]);
		const history = parseEntryHistoryResponse((await request('GET', `${url}/history`)).json());
		expect(history).toMatchObject([
			{ action: 'edited', before: { revision: 2, localDate: source.localDate }, after: { revision: 3, localDate: '2026-10-26' } },
			{ action: 'edited', before: { description: source.description, revision: 1 }, after: { description: 'Corrected description', revision: 2 } },
			{ action: 'created', before: null, after: source },
		]);
	});

	it('keeps the saved rate on reassignment and rechecks an explicitly selected current default at save', async () => {
		const first = await addClient('Original', 80_000n);
		const second = await addClient('Replacement', 90_000n);
		const target = await addProject(second.id);
		const source = await createEntry({ directClientId: first.id });
		const url = `${entriesPath}/${source.id}`;
		const reassigned = change(source, { directClientId: null, projectId: target.id });
		const saved = await request('PUT', url, reassigned);
		expect(saved.statusCode).toBe(200);
		const entry = parseEntryResponse(saved.json());
		expect(entry).toMatchObject({ revision: 2, clientId: second.id, assignedRateOrePerHour: '80000', billableAmountOre: '120000' });
		const currentRate = change(entry, { rate: { mode: 'current', expectedDefaultRateOrePerHour: '90000' } });
		expect(parseEntryEditPreview((await request('POST', `${url}/edit-preview`, currentRate)).json())).toMatchObject({ billableAmountOre: '135000' });
		await database.client.update({ where: { id: second.id }, data: { defaultRateOrePerHour: 95_000n } });
		expect((await request('PUT', url, currentRate)).json()).toMatchObject({ code: 'ENTRY_DEFAULT_RATE_CHANGED' });
		const contenders = await Promise.all([
			request('PUT', url, change(entry, { rate: { mode: 'override', rateOrePerHour: '0' } })),
			request('PUT', url, change(entry, { description: 'Another device' })),
		]);
		expect(contenders.map(({ statusCode }) => statusCode).sort()).toEqual([200, 409]);
		expect(contenders.find(({ statusCode }) => statusCode === 409)?.json()).toMatchObject({ code: 'REVISION_CONFLICT' });
		const winner = parseEntryResponse(contenders.find(({ statusCode }) => statusCode === 200)!.json());
		const zero = await request('PUT', url, change(winner, { rate: { mode: 'override', rateOrePerHour: '0' } }));
		expect(parseEntryResponse(zero.json())).toMatchObject({ assignedRateOrePerHour: '0', billableAmountOre: '0' });
	});

	it('converts both ways, requires overlap confirmation for a changed interval, and rolls back failed allocation rebuilds', async () => {
		await createTimedEntry();
		const source = await createEntry({ durationSeconds: 1_800, billable: true, rateOverrideOrePerHour: '3600' });
		const url = `${entriesPath}/${source.id}`;
		const payload = change(source, { time: { kind: 'timed', startLocal: '2026-11-11T23:45', endLocal: '2026-11-12T00:45' } });
		const preview = await request('POST', `${url}/edit-preview`, payload);
		expect(parseEntryEditPreview(preview.json())).toEqual({ durationSeconds: 3_600, assignedRateOrePerHour: '3600', billableAmountOre: '3600', overlap: true });
		expect((await request('PUT', url, payload)).json()).toMatchObject({ code: 'ENTRY_OVERLAP' });
		await database.$executeRaw`CREATE TRIGGER "test_edit_fail_allocation" BEFORE INSERT ON "EntryDayAllocation"
			BEGIN SELECT RAISE(ABORT, 'Test allocation failure'); END`;
		expect((await request('PUT', url, { ...payload, confirmOverlap: true })).statusCode).toBe(500);
		expect(parseEntryResponse((await request('GET', url)).json())).toEqual(source);
		expect(await database.entryDayAllocation.count({ where: { entryId: source.id } })).toBe(1);
		expect(await database.entryHistory.count({ where: { entryId: source.id } })).toBe(1);
		await database.$executeRaw`DROP TRIGGER "test_edit_fail_allocation"`;
		const convertedResponse = await request('PUT', url, { ...payload, confirmOverlap: true });
		expect(convertedResponse.statusCode).toBe(200);
		const converted = parseEntryResponse(convertedResponse.json());
		expect(converted).toMatchObject({ id: source.id, kind: 'timed', revision: 2, allocations: [
			{ localDate: '2026-11-11', seconds: 900, amountOre: '900' }, { localDate: '2026-11-12', seconds: 2_700, amountOre: '2700' },
		] });
		const back = await request('PUT', url, change(converted, {
			time: { kind: 'duration-only', localDate: '2026-11-13', durationSeconds: 3_600 }, billable: false,
		}));
		expect(parseEntryResponse(back.json())).toMatchObject({ id: source.id, revision: 3, kind: 'duration-only', billableAmountOre: '0', assignedRateOrePerHour: '3600' });
		expect(await database.entryDayAllocation.findMany({ where: { entryId: source.id } })).toMatchObject([
			{ localDate: '2026-11-13', seconds: 3_600, amountOre: 0n },
		]);
	});

	it('guards invoiced work for preview, edit and incomplete completion without hiding history', async () => {
		const source = await createTimedEntry({ billable: true, rateOverrideOrePerHour: '1' });
		const invoicedAt = new Date('2026-11-30T12:00:00.000Z');
		await database.entry.update({ where: { id: source.id }, data: { invoicedAt } });
		const url = `${entriesPath}/${source.id}`;
		expect(parseEntryResponse((await request('GET', url)).json())).toMatchObject({ invoicedAt: invoicedAt.toISOString() });
		const edit = change(source, { description: 'Unauthorized correction' });
		for (const attempted of [request('POST', `${url}/edit-preview`, edit), request('PUT', url, edit)]) {
			const response = await attempted;
			expect(response.statusCode).toBe(409);
			expect(response.json()).toMatchObject({ code: 'ENTRY_INVOICED' });
		}
		const history = parseEntryHistoryResponse((await request('GET', `${url}/history`)).json());
		expect(history).toMatchObject([{ action: 'created', after: source }]);
		await database.entryDayAllocation.deleteMany({ where: { entryId: source.id } });
		await database.entry.update({ where: { id: source.id }, data: { completion: 'incomplete', billableAmountOre: null, description: '' } });
		const completion = await request('POST', `${url}/complete`, { revision: source.revision, description: 'Complete', rateOverrideOrePerHour: null });
		expect(completion.statusCode).toBe(409);
		expect(completion.json()).toMatchObject({ code: 'ENTRY_INVOICED' });
	});

	it('defaults to the current Stockholm week and validates inclusive date shortcuts and range', async () => {
		const sunday = await createEntry({ localDate: '2026-11-15' });
		const monday = await createEntry({ localDate: '2026-11-16' });
		const nextSunday = await createEntry({ localDate: '2026-11-22' });
		await createEntry({ localDate: '2026-11-23' });
		const week = await readWork();
		expect(week.range).toEqual({ from: '2026-11-16', to: '2026-11-22' });
		expect(week.groups.flatMap(({ rows }) => rows.map(({ entry }) => entry.id))).toEqual([nextSunday.id, monday.id]);
		expect((await readWork({ preset: 'today' })).groups[0]?.rows[0]?.entry.id).toBe(monday.id);
		expect((await readWork({ preset: 'this-month' })).range).toEqual({ from: '2026-11-01', to: '2026-11-30' });
		expect((await readWork({ preset: 'previous-month' })).range).toEqual({ from: '2026-10-01', to: '2026-10-31' });
		expect((await readWork({ from: sunday.localDate, to: monday.localDate, sort: 'oldest' })).groups.flatMap(({ rows }) => rows.map(({ entry }) => entry.id)))
			.toEqual([sunday.id, monday.id]);
		for (const query of ['preset=custom&from=2026-11-16', 'from=2026-02-29&to=2026-03-02', 'from=2026-11-16&to=2026-11-15',
			'preset=today&from=2026-11-16&to=2026-11-16', 'from=0000-01-01&to=2026-03-02']) {
			const rejected = await request('GET', `${workListPath}?${query}`);
			expect(rejected.statusCode).toBe(422);
			expect(rejected.json()).toMatchObject({ code: 'INVALID_DATE_RANGE' });
		}
		expect((await request('GET', `${workListPath}?page=0`)).statusCode).toBe(400);
		expect((await request('GET', `${workListPath}?pageSize=101`)).json()).toMatchObject({ code: 'INVALID_PAGE_SIZE' });
	});

	it('combines historical associations, invoice/billability and literal Unicode text searches before pagination', async () => {
		const client = await addClient('Main client', 80_000n);
		const other = await addClient('Another client', 80_000n);
		const project = await addProject(client.id);
		const invoiced = await createEntry({ description: 'Årsrapport 100%_ok', localDate: '2026-11-16', projectId: project.id });
		const unmarked = await createEntry({ description: 'Årsrapport 100%_ok', localDate: '2026-11-16', projectId: project.id });
		await createEntry({ description: 'Årsrapport 100%_ok', localDate: '2026-11-16', projectId: project.id, billable: false });
		const direct = await createEntry({ description: 'Årsrapport 100%_ok', localDate: '2026-11-16', directClientId: client.id });
		const wildcardLookalike = await createEntry({ description: 'Årsrapport 100xyok', localDate: '2026-11-16', projectId: project.id });
		await database.entry.updateMany({ where: { id: { in: [invoiced.id, wildcardLookalike.id] } }, data: {
			invoicedAt: new Date('2026-11-19T12:00:00.000Z'), invoiceNumber: 'SE_000%17',
		} });
		await database.client.update({ where: { id: client.id }, data: { archivedAt: new Date() } });
		await database.project.update({ where: { id: project.id }, data: { archivedAt: new Date() } });
		const scope = { clientId: client.id, projectId: project.id, description: ' a\u030arsrapport 100%_OK ' };
		const combined = await readWork({ ...scope, invoice: 'invoiced', billability: 'billable', invoiceNumber: '_000%1', pageSize: '1' });
		expect(combined.totalRows).toBe(1);
		expect(combined.groups[0]?.rows[0]?.entry).toMatchObject({ id: invoiced.id, invoiceNumber: 'SE_000%17', clientId: client.id });
		const uninvoiced = await readWork({ ...scope, invoice: 'not-yet-invoiced' });
		expect(uninvoiced.groups.flatMap(({ rows }) => rows.map(({ entry }) => entry.id))).toEqual([unmarked.id]);
		const clientWork = await readWork({ clientId: client.id, invoice: 'not-yet-invoiced' });
		expect(clientWork.groups.flatMap(({ rows }) => rows.map(({ entry }) => entry.id)).sort()).toEqual([direct.id, unmarked.id].sort());
		const incompatible = await readWork({ ...scope, clientId: other.id });
		expect(incompatible).toMatchObject({ incompatibleSelection: true, totalRows: 0, groups: [], incomplete: [], totals: { seconds: 0, amountOre: '0' } });
		expect((await readWork({ ...scope, invoice: 'not-yet-invoiced', billability: 'non-billable' })).totalRows).toBe(0);
	});

	it('uses only in-range stored allocations, conserves large totals before pages and shows incomplete work separately', async () => {
		const crossing = await createTimedEntry({ startLocal: '2026-11-15T23:30', endLocal: '2026-11-16T00:30',
			billable: true, rateOverrideOrePerHour: '1' });
		await createEntry({ localDate: '2026-11-16', durationSeconds: 3_600, billable: true, rateOverrideOrePerHour: maxHourlyRateOre });
		await createEntry({ localDate: '2026-11-16', durationSeconds: 3_600, billable: true, rateOverrideOrePerHour: maxHourlyRateOre });
		await database.entry.create({ data: {
			id: randomUUID(), accountId, kind: 'timed', completion: 'incomplete', description: '', localDate: '2026-11-15',
			startAt: new Date('2026-11-15T22:15:00.000Z'), endAt: new Date('2026-11-15T23:15:00.000Z'),
			durationSeconds: 3_600, billable: false,
		} });
		const page1 = await readWork({ pageSize: '1' });
		const page2 = await readWork({ pageSize: '1', page: '2' });
		const page3 = await readWork({ pageSize: '1', page: '999' });
		for (const [index, page] of [page1, page2, page3].entries()) {
			expect(page).toMatchObject({ page: index + 1, totalPages: 3, totalRows: 3,
				totals: { seconds: 9_000, amountOre: '18446744073709551614' }, incomplete: [{ completion: 'incomplete', localDate: '2026-11-15' }] });
			expect(page.groups).toHaveLength(1);
			expect(page.groups[0]?.localDate).toBe('2026-11-16');
		}
		const allPageRows = [page1, page2, page3].flatMap(({ groups }) => groups.flatMap(({ rows }) => rows));
		expect(new Set(allPageRows.map(({ entry }) => entry.id)).size).toBe(3);
		expect(allPageRows.find(({ entry }) => entry.id === crossing.id)).toMatchObject({ seconds: 1_800, amountOre: '0' });
		const sunday = await readWork({ from: '2026-11-15', to: '2026-11-15' });
		expect(sunday.totals).toEqual({ seconds: 1_800, amountOre: '1' });
		expect(sunday.groups[0]?.rows[0]).toMatchObject({ entry: { id: crossing.id }, seconds: 1_800, amountOre: '1' });
		const range = await readWork({ from: '2026-11-15', to: '2026-11-16', sort: 'oldest' });
		expect(range.groups.map(({ localDate }) => localDate)).toEqual(['2026-11-15', '2026-11-16']);
		expect(range.totalRows).toBe(4);
		expect(range.totals).toEqual({ seconds: 10_800, amountOre: '18446744073709551615' });
	});

	it('moves work to trash and restores the same allocations, identity, historical association and history', async () => {
		const client = await addClient('Historical client', 80_000n);
		const project = await addProject(client.id);
		const entry = await createTimedEntry({ projectId: project.id, rateOverrideOrePerHour: '1' });
		const url = `${entriesPath}/${entry.id}`;
		const range = { from: '2026-11-11', to: '2026-11-12' };
		expect((await readWork(range)).totals).toEqual({ seconds: 3_600, amountOre: '1' });
		const originalAllocations = await database.entryDayAllocation.findMany({ where: { entryId: entry.id }, orderBy: { localDate: 'asc' } });
		const removal = await request('POST', `${url}/delete`, { revision: entry.revision });
		expect(removal.statusCode).toBe(200);
		const trash = parseTrashedEntryResponse(removal.json());
		expect(trash).toEqual({ entry: { ...entry, revision: 2, deletedAt: now }, deletedAt: now, restoreUntil: '2026-12-15T23:30:00.000Z' });
		expect((await app.inject({ url: entryTrashPath })).statusCode).toBe(401);
		expect(parseEntryTrashResponse((await request('GET', entryTrashPath)).json())).toEqual([trash]);
		expect(parseEntryListResponse((await request('GET', entriesPath)).json())).toEqual([]);
		expect((await readWork(range)).totals).toEqual({ seconds: 0, amountOre: '0' });
		expect((await request('GET', url)).statusCode).toBe(404);
		expect((await request('GET', `${url}/history`)).statusCode).toBe(404);
		expect((await request('POST', `${url}/edit-preview`, change(trash.entry))).statusCode).toBe(404);
		expect((await request('PUT', url, change(trash.entry))).statusCode).toBe(404);
		expect((await request('POST', `${url}/complete`, { revision: 2, description: 'Still deleted', rateOverrideOrePerHour: null })).statusCode).toBe(404);
		expect((await request('POST', `${url}/delete`, { revision: 2 })).json()).toMatchObject({ code: 'ENTRY_ALREADY_DELETED' });
		expect((await request('POST', `${url}/restore`, { revision: 1 })).json()).toMatchObject({ code: 'REVISION_CONFLICT' });
		const reassignment = await request('PUT', `${projectsPath}/${project.id}`, { clientId: null,
			name: project.name, notes: null, defaultBillable: true, rateOverrideOrePerHour: null, revision: 1 });
		expect(reassignment.json()).toMatchObject({ code: 'PROJECT_CLIENT_LOCKED' });
		await database.client.update({ where: { id: client.id }, data: { archivedAt: new Date(now), defaultRateOrePerHour: 90_000n } });
		await database.project.update({ where: { id: project.id }, data: { archivedAt: new Date(now) } });
		const overlapping = await createTimedEntry({ description: 'Allowed while old interval is in trash' });
		expect(overlapping.id).not.toBe(entry.id);
		const restored = await request('POST', `${url}/restore`, { revision: 2 });
		expect(restored.statusCode).toBe(200);
		const active = parseEntryResponse(restored.json());
		expect(active).toEqual({ ...entry, revision: 3 });
		expect(await database.entryDayAllocation.findMany({ where: { entryId: entry.id }, orderBy: { localDate: 'asc' } })).toEqual(originalAllocations);
		expect((await readWork(range)).totals).toEqual({ seconds: 7_200, amountOre: '1' });
		expect(parseEntryTrashResponse((await request('GET', entryTrashPath)).json())).toEqual([]);
		const history = parseEntryHistoryResponse((await request('GET', `${url}/history`)).json());
		expect(history).toHaveLength(3);
		expect(history.find(({ action }) => action === 'deleted')).toMatchObject({ before: entry, after: trash.entry });
		expect(history.find(({ action }) => action === 'restored')).toMatchObject({ before: trash.entry, after: active });
	});

	it('allows restore just before the deadline and retains an inaccessible tombstone from the exact expiry onward', async () => {
		const eligible = await createEntry({ description: 'Restore at final instant' });
		const expired = await createEntry({ description: 'Keep tombstone' });
		for (const entry of [eligible, expired]) expect((await request('POST', `${entriesPath}/${entry.id}/delete`, { revision: 1 })).statusCode).toBe(200);
		now = '2026-12-15T23:29:59.999Z';
		expect(parseEntryTrashResponse((await request('GET', entryTrashPath)).json())).toHaveLength(2);
		expect((await request('POST', `${entriesPath}/${eligible.id}/restore`, { revision: 2 })).statusCode).toBe(200);
		now = '2026-12-15T23:30:00.000Z';
		expect(parseEntryTrashResponse((await request('GET', entryTrashPath)).json())).toEqual([]);
		const expiredUrl = `${entriesPath}/${expired.id}`;
		expect((await request('POST', `${expiredUrl}/restore`, { revision: 2 })).json()).toMatchObject({ code: 'ENTRY_RESTORE_EXPIRED' });
		expect((await request('GET', expiredUrl)).statusCode).toBe(404);
		expect(await database.entry.findUnique({ where: { id: expired.id } })).toMatchObject({ revision: 2, deletedAt: new Date('2026-11-15T23:30:00.000Z') });
		expect(await database.entryHistory.count({ where: { entryId: expired.id } })).toBe(2);
		expect(await database.entryDayAllocation.count({ where: { entryId: expired.id } })).toBe(1);
	});

	it('rejects invoiced deletion and makes concurrent trash transitions and history writes atomic', async () => {
		const entry = await createEntry();
		const url = `${entriesPath}/${entry.id}`;
		await database.entry.update({ where: { id: entry.id }, data: { invoicedAt: new Date(now) } });
		expect((await request('POST', `${url}/delete`, { revision: 1 })).json()).toMatchObject({ code: 'ENTRY_INVOICED' });
		await database.entry.update({ where: { id: entry.id }, data: { invoicedAt: null } });
		await database.$executeRaw`CREATE TRIGGER "test_fail_delete_history" BEFORE INSERT ON "EntryHistory"
			WHEN NEW."action" = 'deleted' BEGIN SELECT RAISE(ABORT, 'Test delete history failure'); END`;
		expect((await request('POST', `${url}/delete`, { revision: 1 })).statusCode).toBe(500);
		expect(parseEntryResponse((await request('GET', url)).json())).toEqual(entry);
		await database.$executeRaw`DROP TRIGGER "test_fail_delete_history"`;
		const deletions = await Promise.all([1, 1].map((revision) => request('POST', `${url}/delete`, { revision })));
		expect(deletions.map(({ statusCode }) => statusCode).sort()).toEqual([200, 409]);
		expect(deletions.find(({ statusCode }) => statusCode === 409)?.json()).toMatchObject({ code: 'REVISION_CONFLICT' });
		const restores = await Promise.all([2, 2].map((revision) => request('POST', `${url}/restore`, { revision })));
		expect(restores.map(({ statusCode }) => statusCode).sort()).toEqual([200, 409]);
		expect(restores.find(({ statusCode }) => statusCode === 409)?.json()).toMatchObject({ code: 'REVISION_CONFLICT' });
		expect((await request('POST', `${url}/restore`, { revision: 3 })).json()).toMatchObject({ code: 'ENTRY_NOT_DELETED' });
		expect(await database.entryHistory.count({ where: { entryId: entry.id } })).toBe(3);
	});

	it('marks individual work with shared textual invoice numbers and corrects only metadata', async () => {
		const first = await createTimedEntry({ startLocal: '2026-11-16T23:30', endLocal: '2026-11-17T00:30', billable: true, rateOverrideOrePerHour: '1' });
		const second = await createEntry({ localDate: '2026-11-16', billable: true, rateOverrideOrePerHour: '0' });
		const firstUrl = `${entriesPath}/${first.id}`;
		const oldAllocations = await database.entryDayAllocation.findMany({ where: { entryId: first.id }, orderBy: { localDate: 'asc' } });
		const metadata = { invoiceNumber: '  SE-00017  ', invoiceDate: '2026-10-31', invoiceReference: '  Project note  ' };
		for (const entry of [first, second]) {
			const marked = await request('POST', `${entriesPath}/${entry.id}/invoice`, { ...metadata, revision: 1 });
			expect(marked.statusCode).toBe(200);
			expect(parseEntryResponse(marked.json())).toEqual({ ...entry, revision: 2, invoicedAt: now,
				invoiceNumber: 'SE-00017', invoiceDate: '2026-10-31', invoiceReference: 'Project note' });
		}
		const markTime = now;
		expect((await readWork({ invoice: 'invoiced', invoiceNumber: 'se-00017' })).totalRows).toBe(3);
		expect((await request('POST', `${firstUrl}/invoice`, { ...metadata, revision: 2 })).json()).toMatchObject({ code: 'ENTRY_ALREADY_INVOICED' });
		expect((await request('PUT', firstUrl, change(first, { revision: 2, description: 'Locked work' }))).json()).toMatchObject({ code: 'ENTRY_INVOICED' });
		expect((await request('POST', `${firstUrl}/delete`, { revision: 2 })).json()).toMatchObject({ code: 'ENTRY_INVOICED' });
		now = '2026-11-16T12:00:00.000Z';
		const correctedResponse = await request('PUT', `${firstUrl}/invoice`, { revision: 2, invoiceNumber: 'SE-00018', invoiceDate: '2026-10-30', invoiceReference: '' });
		expect(correctedResponse.statusCode).toBe(200);
		const corrected = parseEntryResponse(correctedResponse.json());
		expect(corrected).toEqual({ ...first, revision: 3, invoicedAt: markTime, invoiceNumber: 'SE-00018', invoiceDate: '2026-10-30' });
		expect(await database.entryDayAllocation.findMany({ where: { entryId: first.id }, orderBy: { localDate: 'asc' } })).toEqual(oldAllocations);
		expect((await readWork({ invoiceNumber: 'SE-00018' })).totalRows).toBe(2);
		const noOp = await request('PUT', `${firstUrl}/invoice`, { revision: 3, invoiceNumber: 'SE-00018', invoiceDate: '2026-10-30' });
		expect(parseEntryResponse(noOp.json())).toEqual(corrected);
		expect((await request('POST', `${firstUrl}/uninvoice`, { revision: 2 })).json()).toMatchObject({ code: 'REVISION_CONFLICT' });
		const unmarked = await request('POST', `${firstUrl}/uninvoice`, { revision: 3 });
		expect(parseEntryResponse(unmarked.json())).toEqual({ ...first, revision: 4 });
		expect((await readWork({ invoice: 'not-yet-invoiced' })).totalRows).toBe(2);
		expect((await readWork({ invoiceNumber: 'SE-00018' })).totalRows).toBe(0);
		const history = parseEntryHistoryResponse((await request('GET', `${firstUrl}/history`)).json());
		expect(history).toHaveLength(4);
		expect(history.find(({ action }) => action === 'invoice-marked')).toMatchObject({ before: first, after: { invoicedAt: markTime, invoiceNumber: 'SE-00017' } });
		expect(history.find(({ action }) => action === 'invoice-metadata-updated')).toMatchObject({ before: { invoiceNumber: 'SE-00017' }, after: corrected });
		expect(history.find(({ action }) => action === 'invoice-unmarked')).toMatchObject({ before: corrected, after: { ...first, revision: 4 } });
		expect((await request('PUT', firstUrl, change(first, { revision: 4, description: 'Unlocked work' }))).statusCode).toBe(200);
		expect((await request('POST', `${firstUrl}/delete`, { revision: 5 })).statusCode).toBe(200);
	});

	it('guards invoice eligibility, date format, ownership state and transactional history', async () => {
		const free = await createEntry({ localDate: '2026-11-16' });
		const billable = await createEntry({ localDate: '2026-11-16', billable: true, rateOverrideOrePerHour: '0' });
		const incomplete = await database.entry.create({ data: {
			id: randomUUID(), accountId, kind: 'timed', completion: 'incomplete', description: '', localDate: '2026-11-16',
			startAt: new Date('2026-11-16T12:00:00.000Z'), endAt: new Date('2026-11-16T12:01:00.000Z'), durationSeconds: 60, billable: true,
		} });
		for (const entry of [free, incomplete]) {
			const invalid = await request('POST', `${entriesPath}/${entry.id}/invoice`, { revision: 1 });
			expect(invalid.statusCode).toBe(422);
			expect(invalid.json()).toMatchObject({ code: 'ENTRY_NOT_INVOICE_ELIGIBLE' });
		}
		const incompleteUrl = `${entriesPath}/${incomplete.id}`;
		await database.$executeRaw`UPDATE "Entry" SET "invoicedAt" = ${new Date(now).getTime()}, "invoiceNumber" = 'Imported-0001' WHERE "id" = ${incomplete.id}`;
		const incompleteCorrection = await request('PUT', `${incompleteUrl}/invoice`, { revision: 1, invoiceNumber: 'Imported-0002' });
		expect(incompleteCorrection.statusCode).toBe(200);
		expect(parseEntryResponse(incompleteCorrection.json())).toMatchObject({ completion: 'incomplete', invoicedAt: now });
		expect(await database.$queryRaw`SELECT typeof("invoicedAt") AS storage FROM "Entry" WHERE "id" = ${incomplete.id}`)
			.toEqual([{ storage: 'integer' }]);
		expect((await request('POST', `${incompleteUrl}/uninvoice`, { revision: 2 })).statusCode).toBe(200);
		const url = `${entriesPath}/${billable.id}`;
		expect((await request('PUT', `${url}/invoice`, { revision: 1 })).json()).toMatchObject({ code: 'ENTRY_NOT_INVOICED' });
		expect((await request('POST', `${url}/uninvoice`, { revision: 1 })).json()).toMatchObject({ code: 'ENTRY_NOT_INVOICED' });
		for (const invoiceDate of ['2025-02-29', '0000-01-01', '2026-04-31']) {
			expect((await request('POST', `${url}/invoice`, { revision: 1, invoiceDate })).json()).toMatchObject({ code: 'INVALID_INVOICE_DATE' });
		}
		expect((await request('POST', `${url}/invoice`, { revision: 1, invoiceNumber: 17 })).statusCode).toBe(400);
		await database.$executeRaw`CREATE TRIGGER "test_fail_invoice_history" BEFORE INSERT ON "EntryHistory"
			WHEN NEW."action" = 'invoice-marked' BEGIN SELECT RAISE(ABORT, 'Test invoice history failure'); END`;
		expect((await request('POST', `${url}/invoice`, { revision: 1 })).statusCode).toBe(500);
		expect(parseEntryResponse((await request('GET', url)).json())).toEqual(billable);
		await database.$executeRaw`DROP TRIGGER "test_fail_invoice_history"`;
		const marking = await Promise.all([1, 1].map((revision) => request('POST', `${url}/invoice`, { revision, invoiceDate: '2024-02-29' })));
		expect(marking.map(({ statusCode }) => statusCode).sort()).toEqual([200, 409]);
		expect(marking.find(({ statusCode }) => statusCode === 409)?.json()).toMatchObject({ code: 'REVISION_CONFLICT' });
		expect((await readWork({ invoice: 'not-yet-invoiced' })).totalRows).toBe(0);
		expect((await request('POST', `${entriesPath}/${free.id}/delete`, { revision: 1 })).statusCode).toBe(200);
		expect((await request('POST', `${entriesPath}/${free.id}/invoice`, { revision: 2 })).statusCode).toBe(404);
	});

	it('previews exact deduplicated full-entry impact, marks atomically and replays after preview expiry', async () => {
		const first = await createTimedEntry({ startLocal: '2026-11-16T23:30', endLocal: '2026-11-17T00:30', billable: true, rateOverrideOrePerHour: '1' });
		const second = await createEntry({ localDate: '2026-11-16', durationSeconds: 3_600, billable: true, rateOverrideOrePerHour: maxHourlyRateOre });
		const range = { from: '2026-11-16', to: '2026-11-17', page: '2', pageSize: '1' };
		const preview = await bulkPreview({ action: 'mark-invoiced', filters: range,
			selection: { mode: 'explicit', entryIds: [first.id, second.id, first.id] },
			metadata: { invoiceNumber: 'SE-00017', invoiceDate: '2026-11-12', invoiceReference: 'Shared' } });
		expect(preview).toMatchObject({ count: 2, seconds: 7_200, amountOre: '9223372036854775808', canCommit: true,
			entries: expect.arrayContaining([{ id: first.id, revision: 1, seconds: 3_600, amountOre: '1', description: first.description, issues: [] }]) });
		expect(await database.entry.count({ where: { invoicedAt: { not: null } } })).toBe(0);
		const key = randomUUID();
		const commits = await Promise.all([bulkCommit(preview.previewToken, key), bulkCommit(preview.previewToken, key)]);
		expect(commits.map(({ statusCode }) => statusCode)).toEqual([200, 200]);
		const original = parseBulkEntryCommitResponse(commits[0]!.json());
		expect(commits[1]?.json()).toEqual(original);
		expect(original).toMatchObject({ action: 'mark-invoiced', count: 2, entryIds: [first.id, second.id].sort(), serverNow: now });
		expect(await database.entry.count({ where: { invoicedAt: new Date(now), invoiceNumber: 'SE-00017', revision: 2 } })).toBe(2);
		expect(await database.entryHistory.count({ where: { operationKey: key, action: 'invoice-marked' } })).toBe(2);
		expect((await bulkCommit(preview.previewToken)).json()).toMatchObject({ code: 'BULK_PREVIEW_CHANGED' });
		expect((await bulkCommit(randomUUID(), key)).json()).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
		now = '2026-11-15T23:45:00.000Z';
		const reversal = await bulkPreview({ action: 'unmark-invoiced', filters: range, selection: { mode: 'all-matching' } });
		expect(await database.bulkEntryPreview.findUnique({ where: { id: preview.previewToken! } })).toBeNull();
		expect((await bulkCommit(preview.previewToken, key)).json()).toEqual(original);
		expect((await bulkCommit(reversal.previewToken)).statusCode).toBe(200);
		expect(await database.entry.count({ where: { invoicedAt: null, invoiceNumber: null, revision: 3 } })).toBe(2);
	});

	it('rejects changed all-page or explicit scope and never applies only a matching subset', async () => {
		const filters = { from: '2026-11-16', to: '2026-11-16', description: 'Matching', page: '2', pageSize: '1' };
		const first = await createEntry({ localDate: filters.from, description: 'Matching first' });
		const second = await createEntry({ localDate: filters.from, description: 'Matching second' });
		const all: BulkEntryPreviewBody = { action: 'delete', filters, selection: { mode: 'all-matching' } };
		const initial = await bulkPreview(all);
		expect(initial).toMatchObject({ count: 2, seconds: 10_800, canCommit: true });
		await createEntry({ localDate: filters.from, description: 'Matching third' });
		expect((await bulkCommit(initial.previewToken)).json()).toMatchObject({ code: 'BULK_PREVIEW_CHANGED' });
		const explicit: BulkEntryPreviewBody = { ...all, selection: { mode: 'explicit', entryIds: [first.id, second.id] } };
		const selected = await bulkPreview(explicit);
		const changed = await request('PUT', `${entriesPath}/${second.id}`, change(second, { description: 'Leaves scope' }));
		expect(changed.statusCode).toBe(200);
		expect((await bulkCommit(selected.previewToken)).json()).toMatchObject({ code: 'BULK_PREVIEW_CHANGED' });
		const invalid = await bulkPreview(explicit);
		expect(invalid).toMatchObject({ canCommit: false, previewToken: null, entries: expect.arrayContaining([expect.objectContaining({ id: second.id, issues: ['outside-selection'] })]) });
		expect(await database.entry.count({ where: { deletedAt: { not: null } } })).toBe(0);
		expect(await database.operationReceipt.count()).toBe(0);
	});

	it('blocks marking even when an outside-date portion has zero amount and displays incomplete eligibility', async () => {
		const timedEntry = await createTimedEntry({ startLocal: '2026-11-16T23:30', endLocal: '2026-11-17T00:30', billable: true, rateOverrideOrePerHour: '0' });
		const incomplete = await database.entry.create({ data: {
			id: randomUUID(), accountId, kind: 'timed', completion: 'incomplete', description: '', localDate: '2026-11-16',
			startAt: new Date('2026-11-16T11:00:00.000Z'), endAt: new Date('2026-11-16T11:01:00.000Z'), durationSeconds: 60, billable: false,
		} });
		const payload: BulkEntryPreviewBody = { action: 'mark-invoiced', filters: { from: '2026-11-16', to: '2026-11-16' }, selection: { mode: 'all-matching' } };
		const preview = await bulkPreview(payload);
		expect(preview).toMatchObject({ count: 2, seconds: 3_660, amountOre: '0', canCommit: false, previewToken: null,
			entries: expect.arrayContaining([expect.objectContaining({ id: timedEntry.id, issues: ['outside-date-range'] }),
				expect.objectContaining({ id: incomplete.id, issues: ['not-completed', 'non-billable'] })]) });
		expect((await bulkCommit(preview.previewToken)).statusCode).toBe(400);
		const deletion = await bulkPreview({ ...payload, action: 'delete' });
		expect(deletion).toMatchObject({ count: 2, seconds: 3_660, canCommit: true,
			entries: expect.arrayContaining([expect.objectContaining({ id: incomplete.id, amountOre: null, seconds: 60 })]) });
		expect((await bulkCommit(deletion.previewToken)).statusCode).toBe(200);
		expect((await readWork(payload.filters)).totalRows).toBe(0);
		expect(parseEntryTrashResponse((await request('GET', entryTrashPath)).json())).toHaveLength(2);
	});

	it('rolls back every bulk mutation on later history failure and rejects expired previews', async () => {
		const first = await createEntry({ localDate: '2026-11-16' });
		const second = await createEntry({ localDate: '2026-11-16' });
		const input: BulkEntryPreviewBody = { action: 'delete', filters: { preset: 'today' }, selection: { mode: 'all-matching' } };
		const preview = await bulkPreview(input);
		const secondWrite = [first.id, second.id].sort()[1];
		await database.$executeRaw`CREATE TRIGGER "test_bulk_history_failure" BEFORE INSERT ON "EntryHistory"
			WHEN NEW."action" = 'deleted' AND (SELECT count(*) FROM "Entry" WHERE "deletedAt" IS NOT NULL) = 2
			BEGIN SELECT RAISE(ABORT, 'Test bulk history failure'); END`;
		const key = randomUUID();
		expect((await bulkCommit(preview.previewToken, key)).statusCode).toBe(500);
		expect(await database.entry.count({ where: { deletedAt: null } })).toBe(2);
		expect(await database.entryHistory.count({ where: { action: 'deleted' } })).toBe(0);
		expect(await database.operationReceipt.count()).toBe(0);
		expect((await database.bulkEntryPreview.findUnique({ where: { id: preview.previewToken! } }))?.consumedAt).toBeNull();
		await database.$executeRaw`DROP TRIGGER "test_bulk_history_failure"`;
		now = '2026-11-15T23:45:00.000Z';
		expect((await bulkCommit(preview.previewToken, key)).json()).toMatchObject({ code: 'BULK_PREVIEW_EXPIRED' });
		const fresh = await bulkPreview(input);
		expect((await bulkCommit(fresh.previewToken, key)).statusCode).toBe(200);
		expect((await database.entry.findUnique({ where: { id: secondWrite } }))?.revision).toBe(2);
	});

	it('selectively invoices the one-öre allocation at midnight and retains the superseded source and exact lineage', async () => {
		const source = await createTimedEntry({ startLocal: '2026-11-16T23:30', endLocal: '2026-11-17T00:30',
			billable: true, rateOverrideOrePerHour: '1' });
		await database.entryDayAllocation.update({ where: { entryId_localDate: { entryId: source.id, localDate: '2026-11-17' } },
			data: { calculationVersion: 2 } });
		const input: BulkEntryPreviewBody = { action: 'mark-invoiced', filters: { from: '2026-11-16', to: '2026-11-16' },
			selection: { mode: 'explicit', entryIds: [source.id] }, metadata: { invoiceNumber: 'SE-0001' } };
		const originalPreview = await bulkPreview(input);
		expect(originalPreview).toMatchObject({ canCommit: false, previewToken: null, seconds: 3_600, amountOre: '1',
			invoiceTotals: { seconds: 1_800, amountOre: '1' }, entries: [{ id: source.id, issues: ['outside-date-range'], split: { portions: [
				{ startAt: '2026-11-16T22:30:00.000Z', endAt: '2026-11-16T23:00:00.000Z', from: '2026-11-16', to: '2026-11-16', seconds: 1_800, amountOre: '1', willInvoice: true },
				{ startAt: '2026-11-16T23:00:00.000Z', endAt: '2026-11-16T23:30:00.000Z', from: '2026-11-17', to: '2026-11-17', seconds: 1_800, amountOre: '0', willInvoice: false },
			] } }] });
		const approved = await bulkPreview({ ...input, splitOutsideRange: true });
		expect(approved).toMatchObject({ canCommit: true, entries: [{ issues: [] }] });
		const key = randomUUID();
		const result = await bulkCommit(approved.previewToken, key);
		expect(result.statusCode, result.body).toBe(200);
		const committed = parseBulkEntryCommitResponse(result.json());
		const [insideId, outsideId] = committed.entryIds;
		expect(committed).toMatchObject({ count: 1, splits: [{ originalEntryId: source.id, childEntryIds: [insideId, outsideId] }] });
		expect((await bulkCommit(approved.previewToken, key)).json()).toEqual(committed);
		const original = parseEntryResponse((await request('GET', `${entriesPath}/${source.id}`)).json());
		expect(original).toEqual({ ...source, revision: 2, supersededAt: now, splitChildEntryIds: [insideId, outsideId] });
		const inside = parseEntryResponse((await request('GET', `${entriesPath}/${insideId}`)).json());
		const outside = parseEntryResponse((await request('GET', `${entriesPath}/${outsideId}`)).json());
		expect(inside).toMatchObject({ splitFromEntryId: source.id, durationSeconds: 1_800, billableAmountOre: '1', invoicedAt: now, invoiceNumber: 'SE-0001' });
		expect(outside).toMatchObject({ splitFromEntryId: source.id, durationSeconds: 1_800, billableAmountOre: '0', assignedRateOrePerHour: '1' });
		expect(outside.invoicedAt).toBeUndefined();
		expect(outside.invoiceNumber).toBeUndefined();
		const fullRange = { from: '2026-11-16', to: '2026-11-17' };
		expect((await readWork(fullRange)).totals).toEqual({ seconds: 3_600, amountOre: '1' });
		expect((await readWork({ ...fullRange, invoice: 'invoiced' })).totals).toEqual({ seconds: 1_800, amountOre: '1' });
		expect((await readWork({ ...fullRange, invoice: 'not-yet-invoiced' })).totals).toEqual({ seconds: 1_800, amountOre: '0' });
		expect(parseEntryListResponse((await request('GET', entriesPath)).json()).map(({ id }) => id).sort()).toEqual([insideId, outsideId].sort());
		expect(parseEntryTrashResponse((await request('GET', entryTrashPath)).json())).toEqual([]);
		for (const [method, path, payload] of [
			['PUT', `${entriesPath}/${source.id}`, change(original, { description: 'Locked source' })],
			['POST', `${entriesPath}/${source.id}/delete`, { revision: 2 }],
			['POST', `${entriesPath}/${source.id}/restore`, { revision: 2 }],
			['POST', `${entriesPath}/${source.id}/invoice`, { revision: 2 }],
		] as const) expect((await request(method, path, payload)).statusCode).toBe(404);
		const originalHistory = parseEntryHistoryResponse((await request('GET', `${entriesPath}/${source.id}/history`)).json());
		expect(originalHistory.find(({ action }) => action === 'split')).toMatchObject({ before: source, after: original });
		const rename = await request('PUT', `${entriesPath}/${outside.id}`, change(outside, { description: 'Outside remains editable' }));
		expect(rename.statusCode).toBe(200);
		expect(await database.entryDayAllocation.findMany({ where: { entryId: outside.id } })).toMatchObject([{ amountOre: 0n, seconds: 1_800, calculationVersion: 2 }]);
		const edited = parseEntryResponse(rename.json());
		const recalculated = await request('PUT', `${entriesPath}/${outside.id}`, change(edited, { rate: { mode: 'override', rateOrePerHour: '3' } }));
		expect(parseEntryResponse(recalculated.json())).toMatchObject({ billableAmountOre: '2', splitFromEntryId: source.id });
		expect(await database.entryDayAllocation.findMany({ where: { entryId: outside.id } })).toMatchObject([{ amountOre: 2n, seconds: 1_800, calculationVersion: 1 }]);
	});

	it('splits both DST boundaries without zero-day children and rolls back all split writes on failure', async () => {
		const source = await createTimedEntry({ startLocal: '2026-10-24T23:30', endLocal: '2026-10-27T00:00',
			billable: true, rateOverrideOrePerHour: '1' });
		const input: BulkEntryPreviewBody = { action: 'mark-invoiced', filters: { from: '2026-10-25', to: '2026-10-25' },
			selection: { mode: 'all-matching' }, splitOutsideRange: true };
		const stale = await bulkPreview(input);
		expect((await request('PUT', `${entriesPath}/${source.id}`, change(source, { description: 'Stale split preview' }))).statusCode).toBe(200);
		expect((await bulkCommit(stale.previewToken)).json()).toMatchObject({ code: 'BULK_PREVIEW_CHANGED' });
		const approved = await bulkPreview(input);
		expect(approved.entries[0]?.split?.portions).toMatchObject([
			{ from: '2026-10-24', to: '2026-10-24', seconds: 1_800, willInvoice: false },
			{ from: '2026-10-25', to: '2026-10-25', seconds: 90_000, willInvoice: true },
			{ from: '2026-10-26', to: '2026-10-26', seconds: 86_400, willInvoice: false },
		]);
		await database.$executeRaw`CREATE TRIGGER "test_split_fail_mark" BEFORE INSERT ON "EntryHistory"
			WHEN NEW."action" = 'invoice-marked' BEGIN SELECT RAISE(ABORT, 'Test split history failure'); END`;
		const key = randomUUID();
		expect((await bulkCommit(approved.previewToken, key)).statusCode).toBe(500);
		expect(await database.entry.count()).toBe(1);
		expect((await database.entry.findUniqueOrThrow({ where: { id: source.id } })).supersededAt).toBeNull();
		expect(await database.entryHistory.count({ where: { action: { in: ['split', 'created-from-split', 'invoice-marked'] } } })).toBe(0);
		expect(await database.operationReceipt.count()).toBe(0);
		await database.$executeRaw`DROP TRIGGER "test_split_fail_mark"`;
		const committed = await bulkCommit(approved.previewToken, key);
		expect(committed.statusCode).toBe(200);
		const children = await database.entry.findMany({ where: { splitFromEntryId: source.id }, orderBy: { startAt: 'asc' } });
		expect(children).toHaveLength(3);
		expect(children[1]?.invoicedAt).toEqual(new Date(now));
		expect(children.filter(({ invoicedAt }) => invoicedAt === null)).toHaveLength(2);
		expect(children.reduce((sum, { durationSeconds }) => sum + durationSeconds, 0)).toBe(source.durationSeconds);
		expect(children.reduce((sum, { billableAmountOre }) => sum + (billableAmountOre ?? 0n), 0n).toString()).toBe(source.billableAmountOre);
	});

	it('builds a report from the same persisted filtered portions and totals as the work list', async () => {
		const client = await addClient('Client', 80_000n);
		const project = await addProject(client.id);
		const source = await createTimedEntry({ startLocal: '2026-11-16T23:30', endLocal: '2026-11-17T00:30',
			description: 'Årsrapport 100%', projectId: project.id, rateOverrideOrePerHour: '1' });
		const unrelated = await createEntry({ localDate: '2026-11-17', projectId: project.id, description: 'Årsrapport 100x' });
		await database.entry.update({ where: { id: unrelated.id }, data: { invoicedAt: new Date(now), invoiceNumber: 'SE_001' } });
		const deleted = await createEntry({ localDate: '2026-11-17', projectId: project.id, description: 'Årsrapport 100%' });
		expect((await request('POST', `${entriesPath}/${deleted.id}/delete`, { revision: 1 })).statusCode).toBe(200);
		await database.entry.create({ data: {
			id: randomUUID(), accountId, kind: 'timed', completion: 'incomplete', description: 'Årsrapport 100%', localDate: '2026-11-17',
			startAt: new Date('2026-11-17T12:00:00.000Z'), endAt: new Date('2026-11-17T12:01:00.000Z'), durationSeconds: 60,
			projectId: project.id, billable: true, invoicedAt: new Date(now), invoiceNumber: 'SE_001',
		} });
		expect((await request('POST', `${entriesPath}/${source.id}/invoice`, { revision: 1, invoiceNumber: 'SE_001' })).statusCode).toBe(200);
		await database.client.update({ where: { id: client.id }, data: { name: 'Archived and renamed', archivedAt: new Date(now) } });
		const filters = { from: '2026-11-17', to: '2026-11-19', clientId: client.id, projectId: project.id,
			invoice: 'invoiced', billability: 'billable', description: ' a\u030arsrapport 100% ', invoiceNumber: 'se_001' } as const;
		const list = await readWork(filters);
		const preview = await readReport({ ...filters, showMoney: 'true' });
		expect(preview).toMatchObject({
			totalSeconds: list.totals.seconds, totalAmountOre: list.totals.amountOre, showMoney: true, incompatibleSelection: false,
			scope: { from: filters.from, to: filters.to, clientId: client.id, clientName: 'Archived and renamed', projectId: project.id },
			days: [{ date: '2026-11-17', seconds: 1_800 }, { date: '2026-11-18', seconds: 0 }, { date: '2026-11-19', seconds: 0 }],
			projectShares: [{ projectId: project.id, clientName: 'Archived and renamed', seconds: 1_800 }],
			summaries: [{ clientId: client.id, projectId: project.id, description: 'Årsrapport 100%', seconds: 1_800, hourlyRateOre: '1', amountOre: '0' }],
		});
		expect(list.incomplete).toHaveLength(1);
		expect(preview.totalAmountOre).toBe('0');
		const immutable = await buildReportData(database, accountId, { ...filters, includeDetails: 'true' }, new Date(now));
		expect(immutable.details).toMatchObject([{ entryId: source.id, date: '2026-11-17', seconds: 1_800, amountOre: 0n }]);
		expect(Object.isFrozen(immutable) && Object.isFrozen(immutable.details?.[0]) && Object.isFrozen(immutable.scope)).toBe(true);
	});

	it('preserves distinct IDs and case in description summaries and groups by rate only when shown', async () => {
		const firstClient = await addClient('Same client', 80_000n);
		const secondClient = await addClient('Same client', 80_000n);
		const firstProject = await addProject(firstClient.id);
		const secondProject = await addProject(firstClient.id);
		const base = { localDate: '2026-11-16', durationSeconds: 3_600, description: 'Review' };
		const source = await createEntry({ ...base, projectId: firstProject.id });
		await database.entry.update({ where: { id: source.id }, data: { description: '  Review  ' } });
		await createEntry({ ...base, projectId: firstProject.id, rateOverrideOrePerHour: '0' });
		await createEntry({ ...base, projectId: firstProject.id, description: 'review' });
		await createEntry({ ...base, projectId: secondProject.id });
		await createEntry({ ...base, directClientId: firstClient.id });
		await createEntry({ ...base, directClientId: secondClient.id });
		await createEntry({ ...base, durationSeconds: 1 });
		const timeOnly = await readReport();
		expect(timeOnly).toMatchObject({ showMoney: false, totalSeconds: 21_601, totalAmountOre: '400000' });
		expect(timeOnly.projectShares).toEqual(expect.arrayContaining([
			{ projectId: firstProject.id, projectName: 'Website', clientName: 'Same client', seconds: 10_800 },
			{ projectId: secondProject.id, projectName: 'Website', clientName: 'Same client', seconds: 3_600 },
			{ projectId: null, projectName: null, clientName: null, seconds: 7_201 },
		]));
		expect(timeOnly.summaries).toHaveLength(6);
		expect(timeOnly.summaries.filter(({ projectId, description }) => projectId === firstProject.id && description === 'Review'))
			.toMatchObject([{ seconds: 7_200, amountOre: '80000', hourlyRateOre: null }]);
		expect(timeOnly.summaries.filter(({ projectId }) => projectId === null).map(({ clientId }) => clientId))
			.toEqual(expect.arrayContaining([null, firstClient.id, secondClient.id]));
		const money = await readReport({ showMoney: 'true' });
		expect(money.summaries).toHaveLength(7);
		expect(money.summaries.filter(({ projectId, description }) => projectId === firstProject.id && description === 'Review')).toEqual(expect.arrayContaining([
			expect.objectContaining({ seconds: 3_600, hourlyRateOre: '0', amountOre: '0' }),
			expect.objectContaining({ seconds: 3_600, hourlyRateOre: '80000', amountOre: '80000' }),
		]));
		expect(money.summaries.reduce((total, { amountOre }) => total + BigInt(amountOre), 0n).toString()).toBe(money.totalAmountOre);
	});

	it('returns complete zero-day series for empty and incompatible reports and validates report bounds and access', async () => {
		const range = { from: '2026-10-24', to: '2026-10-26' };
		const empty = await readReport(range);
		expect(empty).toMatchObject({ totalSeconds: 0, totalAmountOre: '0', projectShares: [], summaries: [],
			days: [{ date: '2026-10-24', seconds: 0 }, { date: '2026-10-25', seconds: 0 }, { date: '2026-10-26', seconds: 0 }] });
		const client = await addClient('First client');
		const another = await addClient('Second client');
		const project = await addProject(client.id);
		expect(await readReport({ ...range, clientId: another.id, projectId: project.id })).toMatchObject({ incompatibleSelection: true, totalSeconds: 0 });
		expect((await request('GET', `${reportPreviewPath}?clientId=${randomUUID()}`)).json()).toMatchObject({ code: 'INVALID_CLIENT' });
		expect((await request('GET', `${reportPreviewPath}?from=2010-01-01&to=2026-01-01`)).json()).toMatchObject({ code: 'REPORT_RANGE_TOO_LONG' });
		expect((await request('GET', `${reportPreviewPath}?from=2026-02-29&to=2026-03-01`)).json()).toMatchObject({ code: 'INVALID_DATE_RANGE' });
		expect((await request('GET', `${reportPreviewPath}?page=2`)).statusCode).toBe(400);
		expect((await app.inject({ url: reportPreviewPath })).statusCode).toBe(401);
		const annual = await readReport({ from: '2024-01-01', to: '2024-12-31' });
		expect(annual.days).toHaveLength(366);
		expect(annual.days[59]).toEqual({ date: '2024-02-29', seconds: 0 });
	});

	it('persists report branding and captures immutable presentation settings and logo bytes without changing totals', async () => {
		const work = await createEntry({ localDate: '2026-11-16', billable: true, rateOverrideOrePerHour: '1' });
		const defaultReport = await readReport();
		expect(defaultReport).toMatchObject({ language: 'en', showMoney: false, includeDetails: false, branding: { businessName: null, logo: null } });
		expect(defaultReport.details).toBeUndefined();
		const owner = await request('PUT', reportSettingsPath, { businessName: '  Väster Studio  ' });
		expect(owner.statusCode).toBe(200);
		expect(parseReportSettingsResponse(owner.json())).toEqual({ businessName: 'Väster Studio', logo: null });
		const upload = await putLogo(png(190));
		expect(upload.statusCode, upload.body).toBe(200);
		const branding = parseReportSettingsResponse(upload.json());
		expect(branding).toMatchObject({ businessName: 'Väster Studio', logo: { width: 1, height: 1 } });
		const firstLogo = branding.logo!;
		const firstDownload = await request('GET', firstLogo.url);
		expect(firstDownload.statusCode).toBe(200);
		expect(firstDownload.headers).toMatchObject({ 'content-type': 'image/png', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
		expect(PNG.sync.read(firstDownload.rawPayload).data).toEqual(Buffer.from([190, 30, 90, 255]));
		expect((await app.inject({ url: firstLogo.url })).statusCode).toBe(401);
		const query = { language: 'sv', includeDetails: 'true', showMoney: 'true' } as const;
		const presented = await readReport(query);
		expect(presented).toMatchObject({ language: 'sv', includeDetails: true, showMoney: true, branding,
			totalSeconds: defaultReport.totalSeconds, totalAmountOre: defaultReport.totalAmountOre,
			details: [{ entryId: work.id, date: work.localDate, hourlyRateOre: '1', amountOre: work.billableAmountOre }] });
		const frozen = await buildReportData(database, accountId, query, new Date(now));
		expect(frozen.logoPngBase64).toBe(firstDownload.rawPayload.toString('base64'));
		expect(Object.isFrozen(frozen.branding.logo)).toBe(true);
		const replaced = parseReportSettingsResponse((await putLogo(png(10), 'image/png', firstLogo.id)).json());
		expect(replaced.logo?.id).not.toBe(firstLogo.id);
		const staleRemoval = await app.inject({ ...session, method: 'DELETE', url: `${reportLogoPath}?expectedLogoId=${firstLogo.id}` });
		expect(staleRemoval.statusCode).toBe(409);
		expect(staleRemoval.json()).toMatchObject({ code: 'REPORT_LOGO_CHANGED' });
		expect((await putLogo(png(20), 'image/png', firstLogo.id)).json()).toMatchObject({ code: 'REPORT_LOGO_CHANGED' });
		expect((await request('GET', firstLogo.url)).statusCode).toBe(404);
		expect((await request('PUT', reportSettingsPath, { businessName: 'Another business' })).statusCode).toBe(200);
		const fresh = await buildReportData(database, accountId, query, new Date(now));
		expect(fresh.branding).toMatchObject({ businessName: 'Another business', logo: { id: replaced.logo?.id } });
		expect(fresh.logoPngBase64).not.toBe(frozen.logoPngBase64);
		expect(frozen.branding).toEqual(branding);
		expect(frozen.logoPngBase64).toBe(firstDownload.rawPayload.toString('base64'));
		const cleared = await app.inject({ ...session, method: 'DELETE', url: `${reportLogoPath}?expectedLogoId=${replaced.logo!.id}` });
		expect(parseReportSettingsResponse(cleared.json())).toEqual({ businessName: 'Another business', logo: null });
		expect((await request('GET', replaced.logo!.url)).statusCode).toBe(404);
	});

	it('rejects malformed, oversized and cross-owner logos without changing saved settings', async () => {
		const valid = png(190);
		const saved = parseReportSettingsResponse((await putLogo(valid)).json());
		const interlaced = Buffer.from(valid);
		interlaced[28] = 1;
		const wide = Buffer.from(valid);
		wide.writeUInt32BE(1_601, 16);
		const duplicateHeader = Buffer.concat([valid.subarray(0, 33), valid.subarray(8, 33), valid.subarray(33)]);
		const badCrc = Buffer.from(valid);
		badCrc[32] = badCrc[32]! ^ 1;
		const inflated = deflateSync(Buffer.alloc(16_384));
		const overInflatedIdat = Buffer.alloc(12 + inflated.length);
		overInflatedIdat.writeUInt32BE(inflated.length);
		overInflatedIdat.write('IDAT', 4);
		inflated.copy(overInflatedIdat, 8);
		overInflatedIdat.writeUInt32BE(crc32(overInflatedIdat.subarray(4, -4)), overInflatedIdat.length - 4);
		const overInflated = Buffer.concat([valid.subarray(0, 33), overInflatedIdat, valid.subarray(-12)]);
		for (const input of [Buffer.from('<svg onload="alert(1)"></svg>'), interlaced, duplicateHeader, badCrc, overInflated, valid.subarray(0, 40),
			Buffer.concat([valid, Buffer.from('trailing')])]) {
			const rejected = await putLogo(input);
			expect(rejected.statusCode, rejected.body).toBe(422);
			expect(rejected.json()).toMatchObject({ code: 'INVALID_REPORT_LOGO' });
		}
		expect((await putLogo(wide)).json()).toMatchObject({ code: 'REPORT_LOGO_DIMENSIONS' });
		expect((await putLogo(Buffer.alloc(maxReportLogoBytes + 1))).statusCode).toBe(413);
		expect((await putLogo(valid, 'image/jpeg')).statusCode).toBe(415);
		expect((await app.inject({ ...session, method: 'PUT', url: reportLogoPath, payload: valid,
			headers: { origin, 'content-type': 'image/png' } })).statusCode).toBe(403);
		expect(parseReportSettingsResponse((await request('GET', reportSettingsPath)).json())).toEqual(saved);
		const foreignId = randomUUID();
		await database.$executeRaw`PRAGMA ignore_check_constraints = ON`;
		try {
			await database.account.create({ data: { id: foreignId, ownerSlot: 2, email: 'branding-other@example.test', passwordHash: 'unused' } });
		} finally {
			await database.$executeRaw`PRAGMA ignore_check_constraints = OFF`;
		}
		session = await sessionFor(foreignId);
		expect((await request('GET', saved.logo!.url)).statusCode).toBe(404);
		expect(parseReportSettingsResponse((await request('GET', reportSettingsPath)).json())).toEqual({ businessName: null, logo: null });
		expect((await readReport()).branding).toEqual({ businessName: null, logo: null });
	});
});
