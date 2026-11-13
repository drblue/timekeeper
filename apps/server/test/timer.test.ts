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
	idempotencyKeyHeader,
	maxHourlyRateOre,
	parseAuthSessionResponse,
	parseContinueEntryPreview,
	parseEntryListResponse,
	parseEntryResponse,
	parseStopTimerResponse,
	parseSwitchTimerResponse,
	parseTimerStateResponse,
	projectsPath,
	timerPath,
	timerStartPath,
	timerStopPath,
	timerSwitchPath,
} from '@timekeeper/contracts';
import type { ContinueTimerBody, RunningTimerResponse, StartTimerBody, StartTimerRequest } from '@timekeeper/contracts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { openDatabase } from '../src/auth/database.ts';
import { createAuthStore, randomToken } from '../src/auth/store.ts';
import { createCatalogStore } from '../src/catalog/store.ts';
import { createEntryStore } from '../src/entries/store.ts';
import { createTimerStore } from '../src/timer/store.ts';

const origin = 'https://timekeeper.example.test';
const initialTime = '2026-10-24T21:30:00.950Z';

function work(overrides: Partial<StartTimerBody> = {}): StartTimerBody {
	return { projectId: null, directClientId: null, rateOverrideOrePerHour: null, ...overrides };
}

describe('Durable timer', () => {
	let fixtureDirectory: string;
	let fixtureFile: string;
	let directory: string;
	let databaseUrl: string;
	let database: Awaited<ReturnType<typeof openDatabase>>;
	let app: Awaited<ReturnType<typeof createApp>>;
	let accountId: string;
	let session: Awaited<ReturnType<typeof sessionFor>>;
	let now: string;

	beforeAll(async () => {
		fixtureDirectory = await mkdtemp(join(tmpdir(), 'timekeeper-timer-migration-'));
		fixtureFile = join(fixtureDirectory, 'test.sqlite');
		execFileSync('npm', ['run', 'db:migrate'], {
			env: { ...process.env, TIMEKEEPER_DATABASE_URL: pathToFileURL(fixtureFile).href },
			stdio: 'pipe',
		});
	});

	afterAll(async () => { await rm(fixtureDirectory, { recursive: true, force: true }); });

	async function open() {
		database = await openDatabase(databaseUrl);
		app = await createApp({
			auth: { config: { origin, trustedProxyAddresses: new Set() }, store: await createAuthStore(database) },
			catalog: createCatalogStore(database), entries: createEntryStore(database),
			timer: createTimerStore(database, () => new Date(now)),
		});
	}

	async function sessionFor(ownerId: string) {
		const token = randomToken();
		await database.session.create({ data: {
			tokenHash: createHash('sha256').update(token).digest('hex'), accountId: ownerId, expiresAt: new Date(Date.now() + 60_000),
		} });
		const cookies = { '__Host-timekeeper-session': token };
		const current = parseAuthSessionResponse((await app.inject({ url: authSessionPath, cookies })).json());
		expect(current.account).not.toBeNull();
		return { cookies, headers: { origin, [csrfHeader]: current.csrfToken } };
	}

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), 'timekeeper-timer-test-'));
		const filename = join(directory, 'test.sqlite');
		await copyFile(fixtureFile, filename);
		databaseUrl = pathToFileURL(filename).href;
		now = initialTime;
		await open();
		accountId = randomUUID();
		await database.account.create({ data: { id: accountId, email: 'timer-owner@example.test', passwordHash: 'unused' } });
		session = await sessionFor(accountId);
	});

	afterEach(async () => {
		await app?.close();
		await database?.$disconnect();
		await rm(directory, { recursive: true, force: true });
	});

	function post(url: string, payload: object, key: string = randomUUID()) {
		return app.inject({ ...session, method: 'POST', url, payload, headers: { ...session.headers, [idempotencyKeyHeader]: key } });
	}

	function start(payload: StartTimerRequest = work(), key?: string) { return post(timerStartPath, payload, key); }
	function stop(timer: RunningTimerResponse, key?: string) {
		return post(timerStopPath, { timerId: timer.id, revision: timer.revision }, key);
	}

	async function started(payload?: StartTimerRequest, key?: string) {
		const response = await start(payload, key);
		expect(response.statusCode, response.body).toBe(201);
		const result = parseTimerStateResponse(response.json());
		if (!result.timer) throw new Error('Expected a running timer');
		return { ...result, timer: result.timer };
	}

	async function stopped(timer: RunningTimerResponse, key?: string) {
		const response = await stop(timer, key);
		expect(response.statusCode, response.body).toBe(200);
		return parseStopTimerResponse(response.json());
	}

	async function continuation(entryId: string, rateChoice: ContinueTimerBody['rateChoice'] = 'saved') {
		const response = await app.inject({ url: `${entriesPath}/${entryId}/continue`, ...session });
		expect(response.statusCode, response.body).toBe(200);
		const preview = parseContinueEntryPreview(response.json());
		return { preview, request: {
			entryId, entryRevision: preview.revision, rateChoice, expectedDefaultRateOrePerHour: preview.currentDefaultRateOrePerHour,
		} };
	}

	it('reopens the same durable timer across restart, then saves DST elapsed work, allocations and history', async () => {
		const startedTimer = await started(work({ description: 'Overnight work', billable: true, rateOverrideOrePerHour: '3600' }));
		expect(startedTimer).toMatchObject({ timer: { startAt: '2026-10-24T21:30:00.000Z' }, serverNow: initialTime });
		await app.close();
		await database.$disconnect();
		now = '2026-10-25T23:30:00.100Z';
		await open();
		session = await sessionFor(accountId);
		const state = await app.inject({ url: timerPath, ...session });
		expect(state.headers['cache-control']).toBe('no-store');
		expect(parseTimerStateResponse(state.json())).toEqual({ timer: startedTimer.timer, serverNow: now });
		expect(parseEntryListResponse((await app.inject({ url: entriesPath, ...session })).json())).toEqual([]);
		const key = randomUUID();
		const { entry } = await stopped(startedTimer.timer, key);
		expect(entry).toMatchObject({
			completion: 'complete', startAt: '2026-10-24T21:30:00.000Z', endAt: '2026-10-25T23:30:00.000Z',
			durationSeconds: 93_600, billableAmountOre: '93600', allocations: [
				{ localDate: '2026-10-24', seconds: 1_800, amountOre: '1800' },
				{ localDate: '2026-10-25', seconds: 90_000, amountOre: '90000' },
				{ localDate: '2026-10-26', seconds: 1_800, amountOre: '1800' },
			],
		});
		expect(parseTimerStateResponse((await app.inject({ url: timerPath, ...session })).json()).timer).toBeNull();
		const history = await database.entryHistory.findFirstOrThrow({ where: { entryId: entry.id } });
		expect(history).toMatchObject({ action: 'created', operationKey: key, beforeSnapshot: null });
		expect(JSON.parse(history.afterSnapshot)).toEqual({ version: 1, entry });
	});

	it('commits only one concurrent start and replays identical requests before checking current state', async () => {
		const keys = [randomUUID(), randomUUID()];
		const payload = work({ description: ' Concurrent work ' });
		const results = await Promise.all(keys.map((key) => start(payload, key)));
		expect(results.map(({ statusCode }) => statusCode).sort()).toEqual([201, 409]);
		expect(results.find(({ statusCode }) => statusCode === 409)?.json()).toMatchObject({ code: 'TIMER_RUNNING' });
		const winning = results.findIndex(({ statusCode }) => statusCode === 201);
		const firstKey = keys[winning]!;
		const original = parseTimerStateResponse(results[winning]!.json());
		expect(await database.runningTimer.count()).toBe(1);
		expect(await database.operationReceipt.count()).toBe(1);
		const timer = original.timer!;
		expect((await start(work({ description: 'Different' }), firstKey)).json()).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
		expect((await stop(timer, firstKey)).json()).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
		expect((await post(timerStopPath, { timerId: timer.id, revision: timer.revision + 1 })).json()).toMatchObject({ code: 'TIMER_CONFLICT' });
		now = '2026-10-24T21:35:00.800Z';
		const stopKey = randomUUID();
		const repeated = await Promise.all([stop(timer, stopKey), stop(timer, stopKey)]);
		expect(repeated.map(({ statusCode }) => statusCode)).toEqual([200, 200]);
		expect(repeated[0]?.json()).toEqual(repeated[1]?.json());
		expect((await stop(timer)).json()).toMatchObject({ code: 'TIMER_CONFLICT' });
		expect(await database.entry.count()).toBe(1);
		expect(await database.entryHistory.count()).toBe(1);
		expect(await database.operationReceipt.count()).toBe(2);
		const replacement = await started(work({ description: 'Replacement' }));
		expect(replacement.timer.id).not.toBe(timer.id);
		expect((await start(work({ description: 'Concurrent work' }), firstKey)).json()).toEqual(original);
		expect((await stop(timer, stopKey)).json()).toEqual(repeated[0]?.json());
		expect(parseTimerStateResponse((await app.inject({ url: timerPath, ...session })).json()).timer).toEqual(replacement.timer);
	});

	it('keeps a running project association stable and stops with its snapshotted rate after archival', async () => {
		const parent = await database.client.create({ data: { id: randomUUID(), accountId, name: 'Client', defaultRateOrePerHour: 80_000n } });
		const project = await database.project.create({ data: { id: randomUUID(), accountId, name: 'Project', clientId: parent.id } });
		const { timer } = await started(work({ description: 'Current work', projectId: project.id }));
		expect(timer).toMatchObject({ clientId: parent.id, projectId: project.id, billable: true, assignedRateOrePerHour: '80000' });
		const reassignment = await app.inject({ ...session, method: 'PUT', url: `${projectsPath}/${project.id}`, payload: {
			name: project.name, notes: null, defaultBillable: true, rateOverrideOrePerHour: null, clientId: null, revision: 1,
		} });
		expect(reassignment.json()).toMatchObject({ code: 'PROJECT_CLIENT_LOCKED' });
		const changed = await app.inject({ ...session, method: 'PUT', url: `${clientsPath}/${parent.id}`, payload: {
			name: 'Renamed client', notes: null, defaultRateOrePerHour: '90000', revision: 1,
		} });
		expect(changed.statusCode).toBe(200);
		expect((await post(`${clientsPath}/${parent.id}/archive`, { revision: 2 })).statusCode).toBe(200);
		expect((await post(`${projectsPath}/${project.id}/archive`, { revision: 1 })).statusCode).toBe(200);
		now = '2026-10-24T22:30:00.600Z';
		const { entry } = await stopped(timer);
		expect(entry).toMatchObject({ completion: 'complete', clientId: parent.id, clientName: 'Renamed client', projectId: project.id,
			assignedRateOrePerHour: '80000', billableAmountOre: '80000' });
		expect((await start(work({ projectId: project.id }))).json()).toMatchObject({ code: 'INVALID_PROJECT' });
	});

	it('preserves incomplete work with no amount/allocations and completes it exactly once with revision protection', async () => {
		const { timer } = await started(work({ billable: true }));
		now = '2026-10-24T21:45:00.600Z';
		const { entry } = await stopped(timer);
		expect(entry).toMatchObject({ completion: 'incomplete', missingFields: ['description', 'rate'], durationSeconds: 900,
			assignedRateOrePerHour: null, billableAmountOre: null, allocations: [] });
		expect(await database.entryDayAllocation.count()).toBe(0);
		expect(parseEntryResponse((await app.inject({ url: `${entriesPath}/${entry.id}`, ...session })).json())).toEqual(entry);
		const url = `${entriesPath}/${entry.id}/complete`;
		const payload = { description: 'Recovered work', rateOverrideOrePerHour: '0', revision: 1 };
		expect((await post(url, { ...payload, durationSeconds: 901 })).json()).toMatchObject({ code: 'INVALID_DURATION' });
		expect((await post(url, { ...payload, rateOverrideOrePerHour: null })).json()).toMatchObject({ code: 'MISSING_HOURLY_RATE' });
		const completed = await Promise.all([post(url, payload), post(url, payload)]);
		expect(completed.map(({ statusCode }) => statusCode).sort()).toEqual([200, 409]);
		const response = parseEntryResponse(completed.find(({ statusCode }) => statusCode === 200)!.json());
		expect(response).toMatchObject({ id: entry.id, completion: 'complete', durationSeconds: 900, revision: 2,
			assignedRateOrePerHour: '0', billableAmountOre: '0', allocations: [{ localDate: '2026-10-24', seconds: 900, amountOre: '0' }] });
		expect(completed.find(({ statusCode }) => statusCode === 409)?.json()).toMatchObject({ code: 'REVISION_CONFLICT' });
		expect((await post(url, { ...payload, revision: 2 })).json()).toMatchObject({ code: 'ENTRY_ALREADY_COMPLETE' });
		const history = await database.entryHistory.findFirstOrThrow({ where: { entryId: entry.id, action: 'completed' } });
		expect(JSON.parse(history.beforeSnapshot!)).toEqual({ version: 1, entry });
		expect(JSON.parse(history.afterSnapshot)).toEqual({ version: 1, entry: response });
	});

	it('preserves immediate stops as zero elapsed and accepts a positive correction', async () => {
		const { timer } = await started(work({ description: 'Fast stop' }));
		const { entry } = await stopped(timer);
		expect(entry).toMatchObject({ startAt: timer.startAt, endAt: timer.startAt, completion: 'incomplete',
			durationSeconds: 0, billableAmountOre: null, allocations: [], missingFields: ['duration'] });
		const completePath = `${entriesPath}/${entry.id}/complete`;
		const payload = { description: 'Fast stop', rateOverrideOrePerHour: null, revision: 1 };
		expect((await post(completePath, payload)).json()).toMatchObject({ code: 'INVALID_DURATION' });
		const overlappingPoint = await post(entriesPath, {
			kind: 'timed', startLocal: '2026-10-24T23:25', endLocal: '2026-10-24T23:35', ...work({ description: 'Manual interval' }),
		});
		expect(overlappingPoint.statusCode).toBe(201);
		const completed = await post(completePath, { ...payload, durationSeconds: 60 });
		expect(completed.statusCode).toBe(200);
		expect(parseEntryResponse(completed.json())).toMatchObject({ completion: 'complete', endAt: '2026-10-24T21:31:00.000Z', durationSeconds: 60 });
	});

	it('preserves an overflow stop as incomplete and retains a timer after clock rollback or an atomic write failure', async () => {
		const { timer } = await started(work({ description: 'Long work', billable: true, rateOverrideOrePerHour: maxHourlyRateOre }));
		now = '2026-10-24T21:29:59.999Z';
		expect((await stop(timer)).json()).toMatchObject({ code: 'TIMER_CLOCK_CONFLICT' });
		now = '2026-10-24T23:30:00.000Z';
		await database.$executeRaw`CREATE TRIGGER "test_fail_history" BEFORE INSERT ON "EntryHistory"
			BEGIN SELECT RAISE(ABORT, 'Test history failure'); END`;
		const key = randomUUID();
		expect((await stop(timer, key)).statusCode).toBe(500);
		expect(await database.entry.count()).toBe(0);
		expect(await database.runningTimer.count()).toBe(1);
		expect(await database.operationReceipt.count()).toBe(1);
		await database.$executeRaw`DROP TRIGGER "test_fail_history"`;
		expect((await stopped(timer, key)).entry).toMatchObject({ completion: 'incomplete', missingFields: ['amount'],
			durationSeconds: 7_200, billableAmountOre: null, allocations: [] });
	});

	it('isolates timer state, operations, receipt keys and incomplete entries by account and enforces CSRF', async () => {
		const key = randomUUID();
		const owner = await started(work(), key);
		expect((await app.inject({ url: timerPath })).statusCode).toBe(401);
		expect((await app.inject({ method: 'POST', url: timerStartPath, ...session, payload: work() })).statusCode).toBe(400);
		expect((await app.inject({ method: 'POST', url: timerStartPath, cookies: session.cookies,
			headers: { origin, [idempotencyKeyHeader]: randomUUID() }, payload: work() })).statusCode).toBe(403);
		now = '2026-10-24T21:31:00.000Z';
		const ownerEntry = (await stopped(owner.timer)).entry;
		const foreignId = randomUUID();
		await database.$executeRaw`PRAGMA ignore_check_constraints = ON`;
		try {
			await database.account.create({ data: { id: foreignId, ownerSlot: 2, email: 'foreign@example.test', passwordHash: 'unused' } });
		} finally {
			await database.$executeRaw`PRAGMA ignore_check_constraints = OFF`;
		}
		session = await sessionFor(foreignId);
		const foreign = await started(work(), key);
		expect(foreign.timer.id).not.toBe(owner.timer.id);
		expect(parseTimerStateResponse((await app.inject({ url: timerPath, ...session })).json()).timer).toEqual(foreign.timer);
		expect((await stop(owner.timer)).json()).toMatchObject({ code: 'TIMER_CONFLICT' });
		expect((await post(`${entriesPath}/${ownerEntry.id}/complete`, {
			description: 'Foreign edit', rateOverrideOrePerHour: null, revision: 1,
		})).statusCode).toBe(404);
		expect((await app.inject({ url: `${entriesPath}/${ownerEntry.id}/continue`, ...session })).statusCode).toBe(404);
		expect((await start({ entryId: ownerEntry.id, entryRevision: 1, rateChoice: 'saved', expectedDefaultRateOrePerHour: null })).json())
			.toMatchObject({ code: 'TIMER_RUNNING' });
		expect((await post(timerSwitchPath, { timerId: owner.timer.id, revision: 1, next: work() })).json()).toMatchObject({ code: 'TIMER_CONFLICT' });
		expect((await post(timerSwitchPath, {
			timerId: foreign.timer.id, revision: 1,
			next: { entryId: ownerEntry.id, entryRevision: 1, rateChoice: 'saved', expectedDefaultRateOrePerHour: null },
		})).statusCode).toBe(404);
		expect(await database.runningTimer.count()).toBe(1);
	});

	it('requires explicit switch, saves both sides at one instant and replays the original switch response', async () => {
		const { timer } = await started(work({ description: 'Current work', billable: true, rateOverrideOrePerHour: '3600' }));
		const next = work({ description: 'Next work', billable: false, rateOverrideOrePerHour: '0' });
		now = '2026-10-24T21:40:00.820Z';
		expect((await start(next)).json()).toMatchObject({ code: 'TIMER_RUNNING' });
		const payload = { timerId: timer.id, revision: timer.revision, next };
		expect((await post(timerSwitchPath, { ...payload, revision: timer.revision + 1 })).json()).toMatchObject({ code: 'TIMER_CONFLICT' });
		expect((await post(timerSwitchPath, { ...payload, next: work({ directClientId: randomUUID() }) })).json()).toMatchObject({ code: 'INVALID_CLIENT' });
		expect(await database.entry.count()).toBe(0);
		expect(await database.operationReceipt.count()).toBe(1);
		expect(parseTimerStateResponse((await app.inject({ url: timerPath, ...session })).json()).timer).toEqual(timer);
		const key = randomUUID();
		const attempts = await Promise.all([post(timerSwitchPath, payload, key), post(timerSwitchPath, payload, key)]);
		expect(attempts.map(({ statusCode }) => statusCode)).toEqual([200, 200]);
		const result = parseSwitchTimerResponse(attempts[0]!.json());
		expect(attempts[1]?.json()).toEqual(result);
		expect(result.serverNow).toBe(now);
		expect(result.entry).toMatchObject({ description: 'Current work', endAt: '2026-10-24T21:40:00.000Z', durationSeconds: 600, billableAmountOre: '600' });
		expect(result.timer).toMatchObject({ description: 'Next work', startAt: result.entry.endAt, assignedRateOrePerHour: '0', billable: false });
		expect(result.timer.id).not.toBe(timer.id);
		expect((await post(timerSwitchPath, { ...payload, next: work({ description: 'Other' }) }, key)).json()).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
		expect((await stop(result.timer, key)).json()).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
		expect(await database.entry.count()).toBe(1);
		expect(await database.runningTimer.count()).toBe(1);
		expect(await database.entryHistory.findFirst({ where: { entryId: result.entry.id } })).toMatchObject({ operationKey: key });
		await stopped(result.timer);
		expect((await post(timerSwitchPath, payload, key)).json()).toEqual(result);
	});

	it('rolls back a switch after the old timer was written if starting the replacement fails', async () => {
		const { timer } = await started(work({ description: 'Current work' }));
		now = '2026-10-24T21:31:00.000Z';
		const payload = { timerId: timer.id, revision: timer.revision, next: work({ description: 'Replacement' }) };
		const key = randomUUID();
		await database.$executeRaw`CREATE TRIGGER "test_fail_replacement" BEFORE INSERT ON "RunningTimer"
			BEGIN SELECT RAISE(ABORT, 'Test replacement failure'); END`;
		expect((await post(timerSwitchPath, payload, key)).statusCode).toBe(500);
		expect(await database.runningTimer.count()).toBe(1);
		expect(await database.entry.count()).toBe(0);
		expect(await database.entryDayAllocation.count()).toBe(0);
		expect(await database.entryHistory.count()).toBe(0);
		expect(await database.operationReceipt.count()).toBe(1);
		await database.$executeRaw`DROP TRIGGER "test_fail_replacement"`;
		const retry = await post(timerSwitchPath, payload, key);
		expect(retry.statusCode).toBe(200);
		const result = parseSwitchTimerResponse(retry.json());
		expect(result.entry.endAt).toBe(result.timer.startAt);
	});

	it('continues copied work at the saved rate by default and supports the chosen current rate', async () => {
		const client = await database.client.create({ data: { id: randomUUID(), accountId, name: 'Client', defaultRateOrePerHour: 80_000n } });
		const project = await database.project.create({ data: { id: randomUUID(), accountId, name: 'Project', clientId: client.id } });
		const sourceResponse = await post(entriesPath, {
			kind: 'duration-only', description: 'Source work', localDate: '2026-10-20', durationSeconds: 3_600,
			projectId: project.id, directClientId: null, rateOverrideOrePerHour: null,
		});
		expect(sourceResponse.statusCode).toBe(201);
		const source = parseEntryResponse(sourceResponse.json());
		const old = await continuation(source.id);
		await database.client.update({ where: { id: client.id }, data: { defaultRateOrePerHour: 90_000n } });
		expect((await start(old.request)).json()).toMatchObject({ code: 'CONTINUE_PREVIEW_CHANGED' });
		expect(await database.runningTimer.count()).toBe(0);
		const { preview, request } = await continuation(source.id);
		expect(preview).toEqual({ entryId: source.id, revision: source.revision, description: 'Source work',
			clientId: client.id, clientName: 'Client', projectId: project.id, projectName: 'Project', directClientId: null,
			billable: true, assignedRateOrePerHour: '80000', currentDefaultRateOrePerHour: '90000' });
		const saved = await started(request);
		expect(saved.timer).toMatchObject({ description: 'Source work', clientId: client.id, projectId: project.id,
			billable: true, assignedRateOrePerHour: '80000' });
		const currentChoice = { ...request, rateChoice: 'current' as const };
		expect((await start(currentChoice)).json()).toMatchObject({ code: 'TIMER_RUNNING' });
		now = '2026-10-24T21:40:00.820Z';
		const switchPayload = { timerId: saved.timer.id, revision: saved.timer.revision, next: currentChoice };
		expect((await post(timerSwitchPath, { ...switchPayload, next: { ...currentChoice, entryRevision: source.revision + 1 } })).json())
			.toMatchObject({ code: 'CONTINUE_PREVIEW_CHANGED' });
		expect(await database.entry.count()).toBe(1);
		const switchResponse = await post(timerSwitchPath, switchPayload);
		expect(switchResponse.statusCode, switchResponse.body).toBe(200);
		const switched = parseSwitchTimerResponse(switchResponse.json());
		expect(switched.entry).toMatchObject({ description: 'Source work', assignedRateOrePerHour: '80000', durationSeconds: 600 });
		expect(switched.entry.id).not.toBe(source.id);
		expect(switched.timer).toMatchObject({ description: 'Source work', startAt: switched.entry.endAt, assignedRateOrePerHour: '90000' });
		expect(parseEntryResponse((await app.inject({ url: `${entriesPath}/${source.id}`, ...session })).json())).toEqual(source);
	});

	it('preserves saved zero and null and uses a selected null default without changing billability', async () => {
		const client = await database.client.create({ data: { id: randomUUID(), accountId, name: 'Client' } });
		const { timer } = await started(work({ description: 'No assigned rate', directClientId: client.id }));
		now = '2026-10-24T21:35:00.000Z';
		const noRateEntry = (await stopped(timer)).entry;
		expect(noRateEntry).toMatchObject({ billable: true, completion: 'incomplete', assignedRateOrePerHour: null });
		await database.client.update({ where: { id: client.id }, data: { defaultRateOrePerHour: 90_000n } });
		const missing = await continuation(noRateEntry.id);
		const savedNull = await started(missing.request);
		expect(savedNull.timer).toMatchObject({ billable: true, assignedRateOrePerHour: null });
		const { timer: zeroTimer } = parseSwitchTimerResponse((await post(timerSwitchPath, {
			timerId: savedNull.timer.id, revision: savedNull.timer.revision,
			next: work({ description: 'Zero', directClientId: client.id, rateOverrideOrePerHour: '0' }),
		})).json());
		now = '2026-10-24T21:36:00.000Z';
		const zeroEntry = (await stopped(zeroTimer)).entry;
		const zero = await continuation(zeroEntry.id);
		const keptZero = await started(zero.request);
		expect(keptZero.timer).toMatchObject({ billable: true, assignedRateOrePerHour: '0' });
		await stopped(keptZero.timer);
		await database.client.update({ where: { id: client.id }, data: { defaultRateOrePerHour: null } });
		const current = await continuation(zeroEntry.id, 'current');
		const key = randomUUID();
		const pickedNull = await started(current.request, key);
		expect(pickedNull.timer).toMatchObject({ billable: true, assignedRateOrePerHour: null });
		await database.client.update({ where: { id: client.id }, data: { archivedAt: new Date(now) } });
		expect((await start(current.request, key)).json()).toEqual(pickedNull);
		expect((await app.inject({ url: `${entriesPath}/${zeroEntry.id}/continue`, ...session })).json()).toMatchObject({ code: 'INVALID_CLIENT' });
		expect((await post(timerSwitchPath, { timerId: pickedNull.timer.id, revision: 1, next: current.request })).json()).toMatchObject({ code: 'INVALID_CLIENT' });
		expect(parseTimerStateResponse((await app.inject({ url: timerPath, ...session })).json()).timer?.id).toBe(pickedNull.timer.id);
	});
});
