import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseReportJobResponse, reportJobsPath } from '@timekeeper/contracts';
import type { ReportJobResponse, ReportPdfBody } from '@timekeeper/contracts';
import { writeForAccount } from '../account-write.ts';
import { ApiRequestError } from '../api-error.ts';
import type { PrismaClient, ReportJob } from '../generated/prisma/client.ts';
import { defaultReportTimeoutMs, maxPendingReportJobs, maxReportPdfBytes, maxReportSnapshotBytes, maxRetainedReportJobs, reportRetentionMs } from './job-limits.ts';
import { captureReportData, reportPreview } from './report-data.ts';
import { runPdfWorker } from './run-pdf-worker.ts';

const pending = ['queued', 'running'];
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const artifactName = new RegExp(`^(${uuid})\\.(pdf|tmp)$`);
const notReady = () => new ApiRequestError(409, 'REPORT_NOT_READY', 'This report is not ready to download.');
const queueFull = () => new ApiRequestError(429, 'REPORT_QUEUE_FULL', 'The PDF queue is full. Try again later.');
const wasExpired = (job: Pick<ReportJob, 'expiresAt' | 'status'>, now: Date) =>
	job.status === 'expired' || (job.expiresAt !== null && job.expiresAt <= now);
const statusFields = { id: true, status: true, createdAt: true, expiresAt: true, errorCode: true } as const;
type StatusRecord = Pick<ReportJob, keyof typeof statusFields>;

function describe(job: StatusRecord, now: Date): ReportJobResponse {
	const status = wasExpired(job, now) ? 'expired' : job.status;
	return parseReportJobResponse({
		id: job.id,
		status,
		createdAt: job.createdAt.toISOString(),
		expiresAt: job.expiresAt?.toISOString() ?? null,
		errorCode: status === 'failed' ? job.errorCode : null,
		downloadUrl: status === 'ready' ? `${reportJobsPath}/${job.id}/download` : null,
	});
}

export function reportTimeoutMs(value: string | undefined) {
	if (value === undefined) return defaultReportTimeoutMs;
	const timeout = Number(value);
	if (!Number.isInteger(timeout) || timeout < 1 || timeout > 600_000) {
		throw new Error('TIMEKEEPER_REPORT_TIMEOUT_MS must be an integer from 1 to 600000.');
	}
	return timeout;
}

interface JobOptions {
	timeoutMs?: number;
	now?: () => Date;
	render?: typeof runPdfWorker;
	logError?: () => void;
}

export async function createReportJobs(database: PrismaClient, directory: string, {
	timeoutMs = defaultReportTimeoutMs, now = () => new Date(), render = runPdfWorker, logError = () => {},
}: JobOptions = {}) {
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const directoryStat = await lstat(directory);
	if (!directoryStat.isDirectory() || (directoryStat.mode & 0o077) !== 0) {
		throw new Error('The report artifact directory must be private.');
	}

	function paths(id: string) {
		if (!artifactName.test(id + '.pdf')) throw new Error('Invalid report artifact identity.');
		return { final: join(directory, id + '.pdf'), temporary: join(directory, id + '.tmp') };
	}
	async function removeOutput(id: string) {
		const file = paths(id);
		await rm(file.temporary, { force: true });
		await rm(file.final, { force: true });
	}

	// The app runs one scheduler per SQLite database. Children never write files or update job state.
	await database.reportJob.updateMany({ where: { status: 'running' }, data: { status: 'queued' } });
	for (const name of await readdir(directory)) {
		const match = artifactName.exec(name);
		if (!match) continue;
		const [, id, extension] = match;
		const job = extension === 'pdf' ? await database.reportJob.findUnique({ where: { id }, select: statusFields }) : null;
		if (!job || job.status !== 'ready' || wasExpired(job, now())) await rm(join(directory, name), { force: true });
	}

	async function expireJobs() {
		const instant = now();
		const due = await database.reportJob.findMany({
			where: { expiresAt: { lte: instant }, status: { in: ['ready', 'failed'] } },
			select: { id: true }, take: maxRetainedReportJobs,
		});
		for (const { id } of due) {
			try {
				await removeOutput(id);
				await database.$transaction((transaction) => transaction.reportJob.update({
					where: { id }, data: { status: 'expired', input: null, errorCode: null },
				}));
			} catch {
				logError();
			}
		}
		await database.$transaction((transaction) => transaction.reportJob.deleteMany({
			where: { status: 'expired', expiresAt: { lte: new Date(instant.getTime() - reportRetentionMs) } },
		}));
	}

	const shutdown = new AbortController();
	let work: Promise<void> | undefined;
	let terminal: { id: string; failure: ReportJobResponse['errorCode']; expiresAt: Date } | undefined;

	async function renderJob(job: ReportJob) {
		try {
			const result = job.input ? await render(job.input, timeoutMs, shutdown.signal) : { errorCode: 'REPORT_RENDER_FAILED' as const };
			if ('errorCode' in result) return result.errorCode;
			if (shutdown.signal.aborted) return 'REPORT_RENDER_FAILED';
			if (result.pdf.length > maxReportPdfBytes) return 'REPORT_OUTPUT_TOO_LARGE';
			const file = paths(job.id);
			await writeFile(file.temporary, result.pdf, { flag: 'wx', mode: 0o600 });
			await rename(file.temporary, file.final);
			return null;
		} catch {
			logError();
			return 'REPORT_RENDER_FAILED';
		}
	}

	async function drain() {
		await expireJobs();
		while (!shutdown.signal.aborted) {
			if (terminal) {
				const { id, failure, expiresAt } = terminal;
				// Keep the result until the next wake if publishing the state encounters a transient failure.
				await database.$transaction((transaction) => transaction.reportJob.updateMany({
					where: { id, status: 'running' }, data: {
						status: failure ? 'failed' : 'ready', expiresAt, input: null, errorCode: failure,
					},
				}));
				terminal = undefined;
				continue;
			}
			const job = await database.$transaction(async (transaction) => {
				const next = await transaction.reportJob.findFirst({
					where: { status: 'queued' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
				});
				if (!next) return null;
				const claim = await transaction.reportJob.updateMany({
					where: { id: next.id, status: 'queued' }, data: { status: 'running' },
				});
				return claim.count === 1 ? next : null;
			});
			if (!job) return;
			const failure = await renderJob(job);
			if (shutdown.signal.aborted) return;
			if (failure) await removeOutput(job.id).catch(logError);
			terminal = { id: job.id, failure, expiresAt: new Date(now().getTime() + reportRetentionMs) };
		}
	}

	function wake() {
		if (work || shutdown.signal.aborted) return;
		work = drain().catch(logError).finally(() => { work = undefined; });
	}
	const tick = setInterval(wake, 2_000);
	tick.unref();
	wake();

	async function getOwned(accountId: string, id: string) {
		const job = await database.$transaction((transaction) => transaction.reportJob.findUnique({
			where: { id, accountId }, select: statusFields,
		}));
		if (!job) throw new ApiRequestError(404, 'REPORT_JOB_NOT_FOUND', 'This report job could not be found.');
		return describe(job, now());
	}

	return {
		async enqueue(accountId: string, query: ReportPdfBody) {
			const job = await writeForAccount(database, accountId, async (transaction) => {
				const instant = now();
				if (await transaction.reportJob.count({ where: { status: { in: pending } } }) >= maxPendingReportJobs
					|| await transaction.reportJob.count({ where: {
						OR: [{ status: { in: pending } }, { status: { in: ['ready', 'failed'] }, expiresAt: { gt: instant } }],
					} }) >= maxRetainedReportJobs) throw queueFull();
				const data = await captureReportData(transaction, accountId, query, instant, true);
				if (data.incompatibleSelection) {
					throw new ApiRequestError(422, 'REPORT_INCOMPATIBLE_SELECTION', 'Choose a client and project that belong together.');
				}
				const input = JSON.stringify({ version: 1, preview: reportPreview(data), logoPngBase64: data.logoPngBase64 });
				if (Buffer.byteLength(input) > maxReportSnapshotBytes) {
					throw new ApiRequestError(422, 'REPORT_INPUT_TOO_LARGE', 'Choose a smaller report scope.');
				}
				return transaction.reportJob.create({
					data: { id: randomUUID(), accountId, status: 'queued', createdAt: instant, input }, select: statusFields,
				});
			});
			wake();
			return describe(job, now());
		},
		get: getOwned,
		async download(accountId: string, id: string) {
			const job = await getOwned(accountId, id);
			if (job.status === 'expired') throw new ApiRequestError(410, 'REPORT_EXPIRED', 'This report has expired.');
			if (job.status !== 'ready') throw notReady();

			const file = await open(paths(id).final, constants.O_RDONLY | constants.O_NOFOLLOW).catch((error: NodeJS.ErrnoException) => {
				if (error.code === 'ENOENT') throw notReady();
				throw error;
			});
			try {
				const stat = await file.stat();
				if (!stat.isFile() || stat.size < 5 || stat.size > maxReportPdfBytes) throw notReady();
				return { stream: file.createReadStream(), size: stat.size };
			} catch (error) {
				await file.close();
				throw error;
			}
		},
		async close() {
			clearInterval(tick);
			shutdown.abort();
			await work;
		},
	};
}
