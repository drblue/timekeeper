import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
	authSessionPath,
	clientsPath,
	csrfHeader,
	entriesPath,
	maxEntryDescriptionLength,
	maxEntryDurationSeconds,
	maxHourlyRateOre,
	parseAuthSessionResponse,
	parseDurationEntryListResponse,
	parseDurationEntryResponse,
	parseProjectResponse,
	projectsPath,
} from '@timekeeper/contracts';
import type { CreateDurationEntryBody } from '@timekeeper/contracts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { openDatabase } from '../src/auth/database.ts';
import { createAuthStore, randomToken } from '../src/auth/store.ts';
import { createCatalogStore } from '../src/catalog/store.ts';
import { createEntryStore } from '../src/entries/store.ts';

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

describe('Duration-only entries', () => {
	let fixtureDirectory: string;
	let fixtureFile: string;
	let directory: string;
	let database: Awaited<ReturnType<typeof openDatabase>>;
	let app: Awaited<ReturnType<typeof createApp>>;
	let accountId: string;
	let session: Awaited<ReturnType<typeof sessionFor>>;

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
		directory = await mkdtemp(join(tmpdir(), 'timekeeper-entries-test-'));
		const filename = join(directory, 'test.sqlite');
		await copyFile(fixtureFile, filename);
		database = await openDatabase(pathToFileURL(filename).href);
		accountId = randomUUID();
		await database.account.create({ data: { id: accountId, email: 'owner@example.test', passwordHash: 'unused' } });
		app = await createApp({
			auth: { config: { origin, trustedProxyAddresses: new Set() }, store: await createAuthStore(database) },
			catalog: createCatalogStore(database),
			entries: createEntryStore(database),
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

	async function createEntry(overrides?: Partial<CreateDurationEntryBody>) {
		const response = await request('POST', entriesPath, work(overrides));
		expect(response.statusCode, response.body).toBe(201);
		return parseDurationEntryResponse(response.json());
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
			localDate: '2026-10-25', durationSeconds: 5_400, projectId: null, directClientId: null,
			clientId: null, projectName: null, clientName: null, billable: false,
			assignedRateOrePerHour: null, billableAmountOre: '0', revision: 1,
		});
		const detail = await request('GET', `${entriesPath}/${entry.id}`);
		expect(detail.statusCode).toBe(200);
		expect(detail.headers['cache-control']).toBe('no-store');
		expect(parseDurationEntryResponse(detail.json())).toEqual(entry);
		const older = await createEntry({ localDate: '2026-10-24', durationSeconds: 1 });
		expect(parseDurationEntryListResponse((await request('GET', entriesPath)).json())).toEqual([entry, older]);
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
		const detail = parseDurationEntryResponse((await request('GET', `${entriesPath}/${historical.id}`)).json());
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
		const entry = parseDurationEntryResponse(entryResponse.json());
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
		expect(parseDurationEntryListResponse((await request('GET', entriesPath)).json())).toEqual([entry]);
	});

	it('enforces sessions, CSRF and ownership for entries and both kinds of related ID', async () => {
		const ownedClient = await addClient('Private client');
		const ownedProject = await addProject(ownedClient.id, 500n);
		const ownedEntry = await createEntry({ projectId: ownedProject.id });
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
		expect(parseDurationEntryListResponse((await request('GET', entriesPath)).json())).toEqual([]);
		const foreignRead = await request('GET', `${entriesPath}/${ownedEntry.id}`);
		expect(foreignRead.statusCode).toBe(404);
		expect(foreignRead.json()).toMatchObject({ code: 'NOT_FOUND' });
		expect((await request('POST', entriesPath, work({ projectId: ownedProject.id }))).json()).toMatchObject({ code: 'INVALID_PROJECT' });
		expect((await request('POST', entriesPath, work({ directClientId: ownedClient.id }))).json()).toMatchObject({ code: 'INVALID_CLIENT' });
		const foreignEntry = await createEntry();
		expect(parseDurationEntryListResponse((await request('GET', entriesPath)).json())).toEqual([foreignEntry]);
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
});
