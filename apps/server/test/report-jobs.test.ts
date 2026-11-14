import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
	authSessionPath, bulkEntryPreviewPath, csrfHeader, entriesPath, healthPath, parseAuthSessionResponse, parseBulkEntryPreviewResponse, parseReportJobResponse,
	parseReportPreviewResponse, parseWorkListResponse, reportJobsPath, reportPdfPath, reportPreviewPath, workListPath,
} from '@timekeeper/contracts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.ts';
import { openDatabase } from '../src/auth/database.ts';
import { createAuthStore, randomToken } from '../src/auth/store.ts';
import { createEntryStore } from '../src/entries/store.ts';
import { maxPendingReportJobs, maxReportAllocations, reportRetentionMs } from '../src/reports/job-limits.ts';
import { createReportJobs } from '../src/reports/jobs.ts';
import { createReportPreview } from '../src/reports/routes.ts';
import { runPdfWorker } from '../src/reports/run-pdf-worker.ts';

const origin = 'https://timekeeper.example.test';
const range = { from: '2026-11-11', to: '2026-11-12' } as const;

describe('Report PDF jobs', () => {
	let fixtureDirectory: string;
	let directory: string;
	let artifactDirectory: string;
	let database: Awaited<ReturnType<typeof openDatabase>>;
	let jobs: Awaited<ReturnType<typeof createReportJobs>>;
	let app: Awaited<ReturnType<typeof createApp>>;
	let accountId: string;
	let owner: Awaited<ReturnType<typeof signIn>>;
	let now: number;

	beforeAll(async () => {
		fixtureDirectory = await mkdtemp(join(tmpdir(), 'timekeeper-jobs-migration-'));
		execFileSync('npm', ['run', 'db:migrate'], {
			env: { ...process.env, TIMEKEEPER_DATABASE_URL: pathToFileURL(join(fixtureDirectory, 'test.sqlite')).href },
			stdio: 'pipe',
		});
	});

	afterAll(async () => {
		await rm(fixtureDirectory, { recursive: true, force: true });
	});

	beforeEach(async () => {
		now = Date.parse('2026-11-12T14:00:00Z');
		directory = await mkdtemp(join(tmpdir(), 'timekeeper-report-jobs-'));
		const filename = join(directory, 'test.sqlite');
		await copyFile(join(fixtureDirectory, 'test.sqlite'), filename);
		database = await openDatabase(pathToFileURL(filename).href);
		artifactDirectory = filename + '.report-artifacts';
		accountId = randomUUID();
		await database.account.create({ data: { id: accountId, email: 'owner@example.test', passwordHash: 'unused' } });
	});

	afterEach(async () => {
		await app?.close();
		await jobs?.close();
		await database?.$disconnect();
		await rm(directory, { recursive: true, force: true });
	});

	async function signIn(id: string) {
		const token = randomToken();
		await database.session.create({
			data: { accountId: id, tokenHash: createHash('sha256').update(token).digest('hex'), expiresAt: new Date(Date.now() + 60_000) },
		});
		const cookies = { '__Host-timekeeper-session': token };
		const current = parseAuthSessionResponse((await app.inject({ url: authSessionPath, cookies })).json());
		expect(current.account).not.toBeNull();
		return { cookies, headers: { origin, [csrfHeader]: current.csrfToken } };
	}

	async function startJobs(options: Parameters<typeof createReportJobs>[2] = {}) {
		jobs = await createReportJobs(database, artifactDirectory, { ...options, now: () => new Date(now) });
		app = await createApp({
			auth: { config: { origin, trustedProxyAddresses: new Set() }, store: await createAuthStore(database) },
			reportPreview: createReportPreview(database), reportJobs: jobs, entries: createEntryStore(database),
		});
		owner = await signIn(accountId);
	}

	function enqueue(payload = range) {
		return app.inject({ ...owner, method: 'POST', url: reportPdfPath, payload });
	}

	async function getJob(id: string) {
		const response = await app.inject({ ...owner, url: `${reportJobsPath}/${id}` });
		expect(response.statusCode, response.body).toBe(200);
		expect(response.headers['cache-control']).toBe('no-store');
		return parseReportJobResponse(response.json());
	}

	function waitForStatus(id: string, status: 'running' | 'ready' | 'failed') {
		return vi.waitFor(async () => {
			const job = await getJob(id);
			expect(job.status).toBe(status);
			return job;
		}, { timeout: 5_000, interval: 35 });
	}

	it('recovers an interrupted capture with its original data, serves it privately and expires its file', async () => {
		const interrupted = vi.fn<typeof runPdfWorker>((_input, _timeoutMs, signal) => new Promise((resolve) => {
			signal.addEventListener('abort', () => resolve({ errorCode: 'REPORT_RENDER_FAILED' }), { once: true });
		}));
		await startJobs({ render: interrupted });

		const original = await app.inject({ ...owner, method: 'POST', url: entriesPath, payload: {
			kind: 'duration-only', localDate: range.from, durationSeconds: 3_600, description: 'Årsrapport',
			billable: true, projectId: null, directClientId: null, rateOverrideOrePerHour: '80001',
		} });
		expect(original.statusCode, original.body).toBe(201);
		const id = original.json().id as string;
		const { logoBytes, logoId } = {
			logoBytes: await readFile('prototype/pdf/fixture-logo.png'), logoId: randomUUID(),
		};
		await database.reportSettings.create({
			data: { accountId, businessName: 'Väster Studio', logoId, logoBytes, logoWidth: 1, logoHeight: 1 },
		});
		const options = { ...range, showMoney: 'true', language: 'sv', includeDetails: 'true', description: 'årsrapport' };
		expect((await app.inject({ method: 'POST', url: reportPdfPath, payload: options })).statusCode).toBe(401);
		expect((await app.inject({ cookies: owner.cookies, method: 'POST', url: reportPdfPath, payload: options })).statusCode).toBe(403);
		const response = await enqueue(options);
		expect(response.statusCode, response.body).toBe(202);
		const queued = parseReportJobResponse(response.json());
		expect(queued).toMatchObject({ status: 'queued', expiresAt: null, downloadUrl: null });
		await waitForStatus(queued.id, 'running');
		expect(interrupted).toHaveBeenCalledTimes(1);
		const downloadPath = `${reportJobsPath}/${queued.id}/download`;
		expect((await app.inject({ ...owner, url: downloadPath })).json()).toMatchObject({ code: 'REPORT_NOT_READY' });
		expect((await app.inject({ url: healthPath })).statusCode).toBe(200);

		await app.close();
		await jobs.close();
		const savedInput = interrupted.mock.calls[0]![0];
		expect(JSON.parse(savedInput)).toMatchObject({
			version: 1, logoPngBase64: Buffer.from(logoBytes).toString('base64'),
			preview: {
				branding: { businessName: 'Väster Studio', logo: { id: logoId } }, totalSeconds: 3_600, totalAmountOre: '80001',
				details: [{ entryId: id, description: 'Årsrapport', hourlyRateOre: '80001', amountOre: '80001' }],
			},
		});
		expect(await database.reportJob.findUnique({ where: { id: queued.id } })).toMatchObject({ status: 'running', input: savedInput });
		await database.entry.update({ where: { id }, data: { description: 'Corrected after capture' } });
		await database.reportSettings.delete({ where: { accountId } });
		await writeFile(join(artifactDirectory, queued.id + '.tmp'), 'interrupted attempt');
		await writeFile(join(artifactDirectory, queued.id + '.pdf'), 'interrupted attempt');
		const render = vi.fn<typeof runPdfWorker>(runPdfWorker);
		await startJobs({ render });
		const ready = await waitForStatus(queued.id, 'ready');
		expect(render.mock.calls[0]![0]).toBe(savedInput);
		expect(ready).toMatchObject({ downloadUrl: downloadPath, expiresAt: new Date(now + reportRetentionMs).toISOString() });
		expect(await database.reportJob.findUnique({ where: { id: queued.id } })).toMatchObject({ status: 'ready', input: null });
		const downloaded = await app.inject({ ...owner, url: downloadPath });
		expect(downloaded.statusCode, downloaded.body.slice(0, 80)).toBe(200);
		expect(downloaded.headers).toMatchObject({
			'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="time-report.pdf"',
			'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
		});
		expect(downloaded.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
		expect(await readdir(artifactDirectory)).toEqual([queued.id + '.pdf']);

		const otherAccount = randomUUID();
		await database.$executeRaw`PRAGMA ignore_check_constraints = ON`;
		try {
			await database.account.create({ data: { id: otherAccount, ownerSlot: 2, email: 'other@example.test', passwordHash: 'unused' } });
		} finally {
			await database.$executeRaw`PRAGMA ignore_check_constraints = OFF`;
		}
		const other = await signIn(otherAccount);
		expect((await app.inject({ ...other, url: `${reportJobsPath}/${queued.id}` })).statusCode).toBe(404);
		expect((await app.inject({ ...other, url: downloadPath })).statusCode).toBe(404);
		expect((await app.inject({ url: downloadPath })).statusCode).toBe(401);
		expect((await app.inject({ ...owner, url: `/${queued.id}.pdf` })).statusCode).toBe(404);

		now += reportRetentionMs;
		expect(await getJob(queued.id)).toMatchObject({ status: 'expired', downloadUrl: null });
		expect((await app.inject({ ...owner, url: downloadPath })).statusCode).toBe(410);
		await vi.waitFor(async () => expect(await readdir(artifactDirectory)).toEqual([]), { timeout: 3_000 });
		expect(await database.entry.count({ where: { accountId } })).toBe(1);
		expect(await database.entryDayAllocation.count({ where: { entryId: id } })).toBe(1);
	});

	it('queues only four reports, runs one child at a time and exposes a timeout or render failure', async () => {
		const worker = join(directory, 'busy.mjs');
		await writeFile(worker, 'await new Promise(() => { setInterval(() => {}, 1000); });\n');
		let active = 0;
		let peak = 0;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		let started = 0;
		const render = vi.fn<typeof runPdfWorker>(async (input, _timeoutMs, signal) => {
			const current = ++started;
			active += 1;
			peak = Math.max(peak, active);
			await Promise.race([gate, new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))]);
			try {
				return current === 1
					? await runPdfWorker(input, 150, signal, worker)
					: await runPdfWorker('invalid', 5_000, signal);
			} finally {
				active -= 1;
			}
		});
		await startJobs({ render });
		const results = await Promise.all(Array.from({ length: maxPendingReportJobs + 1 }, () => enqueue()));
		const admitted = results.filter((result) => result.statusCode === 202).map((result) => parseReportJobResponse(result.json()));
		expect(admitted).toHaveLength(maxPendingReportJobs);
		expect(results.find((result) => result.statusCode === 429)?.json()).toMatchObject({ code: 'REPORT_QUEUE_FULL' });
		expect((await app.inject({ url: healthPath })).statusCode).toBe(200);
		release();
		const completed = await Promise.all(admitted.map(({ id }) => waitForStatus(id, 'failed')));
		expect(peak).toBe(1);
		expect(completed.map(({ errorCode }) => errorCode).sort()).toEqual([
			'REPORT_RENDER_FAILED', 'REPORT_RENDER_FAILED', 'REPORT_RENDER_FAILED', 'REPORT_TIMEOUT',
		]);
		expect(await readdir(artifactDirectory)).toEqual([]);
	});

	it('retries terminal publication without rerendering and rejects oversized child output', async () => {
		const oversized = join(directory, 'oversized.mjs');
		await writeFile(oversized, 'process.stdout.write(Buffer.alloc(25 * 1024 * 1024, 42));\n');
		const rejected = await runPdfWorker('', 5_000, new AbortController().signal, oversized);
		expect(rejected).toEqual({ errorCode: 'REPORT_OUTPUT_TOO_LARGE' });

		await database.$executeRaw`CREATE TRIGGER "test_report_publish_retry" BEFORE UPDATE ON "ReportJob"
			WHEN NEW."status" = 'ready' BEGIN SELECT RAISE(ABORT, 'Test publication failure'); END`;
		const render = vi.fn<typeof runPdfWorker>(runPdfWorker);
		const logError = vi.fn();
		await startJobs({ render, logError });
		const response = await enqueue();
		expect(response.statusCode, response.body).toBe(202);
		const { id } = parseReportJobResponse(response.json());
		await vi.waitFor(() => expect(logError).toHaveBeenCalled(), { timeout: 3_000 });
		expect((await getJob(id)).status).toBe('running');
		expect((await app.inject({ ...owner, url: `${reportJobsPath}/${id}/download` })).statusCode).toBe(409);
		await database.$executeRaw`DROP TRIGGER "test_report_publish_retry"`;
		await waitForStatus(id, 'ready');
		expect(render).toHaveBeenCalledTimes(1);
	});

	it('pages allocation reads for previews and lists, but bounds PDF capture even before text search', async () => {
		const seeds = Array.from({ length: maxReportAllocations + 1 }, (_, index) => ({
			id: randomUUID(), accountId, kind: 'duration-only', description: index % 2 ? 'Årligt arbete' : 'Not matched',
			localDate: range.from, durationSeconds: 3_600, billable: false, billableAmountOre: 0n,
		}));
		await database.entry.createMany({ data: seeds });
		await database.entryDayAllocation.createMany({
			data: seeds.map(({ id: entryId, localDate }) => ({ entryId, localDate, seconds: 3_600, amountOre: 0n, calculationVersion: 1 })),
		});
		await startJobs();
		const filters = { ...range, description: 'årligt', includeDetails: 'true' };
		const preview = parseReportPreviewResponse((await app.inject({
			...owner, url: `${reportPreviewPath}?${new URLSearchParams(filters)}`,
		})).json());
		const list = parseWorkListResponse((await app.inject({
			...owner, url: `${workListPath}?${new URLSearchParams({ ...range, description: 'årligt' })}`,
		})).json());
		expect(preview.details).toHaveLength(4_000);
		expect(new Set(preview.details?.map(({ entryId }) => entryId)).size).toBe(4_000);
		expect(preview.totalSeconds).toBe(4_000 * 3_600);
		expect(list.totals.seconds).toBe(preview.totalSeconds);
		const rejected = await enqueue(filters);
		expect(rejected.statusCode, rejected.body).toBe(422);
		expect(rejected.json()).toMatchObject({ code: 'REPORT_INPUT_TOO_LARGE' });
		expect(await database.reportJob.count()).toBe(0);
		const explicitIds = seeds.filter((_, index) => index % 2).slice(0, 1_000).map(({ id }) => id);
		const bulk = await app.inject({ ...owner, method: 'POST', url: bulkEntryPreviewPath, payload: {
			action: 'delete', filters: { ...range, description: 'årligt' }, selection: { mode: 'explicit', entryIds: explicitIds },
		} });
		expect(bulk.statusCode, bulk.body.slice(0, 200)).toBe(200);
		const explicit = parseBulkEntryPreviewResponse(bulk.json());
		expect(explicit).toMatchObject({ count: 1_000, canCommit: true });
		expect(explicit.entries.map(({ id }) => id)).toEqual(explicitIds.sort());
		const all = await app.inject({ ...owner, method: 'POST', url: bulkEntryPreviewPath, payload: {
			action: 'delete', filters: { ...range, description: 'årligt' }, selection: { mode: 'all-matching' },
		} });
		expect(all.statusCode, all.body.slice(0, 200)).toBe(200);
		const allMatching = parseBulkEntryPreviewResponse(all.json());
		expect(allMatching).toMatchObject({ count: 4_000, canCommit: true, seconds: preview.totalSeconds });
		expect(allMatching.entries.map(({ id }) => id)).toEqual(preview.details?.map(({ entryId }) => entryId).sort());
	});
});
