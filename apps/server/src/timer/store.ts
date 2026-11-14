import { randomUUID } from 'node:crypto';
import { parseStopTimerResponse, parseSwitchTimerResponse, parseTimerStateResponse } from '@timekeeper/contracts';
import type { RunningTimerResponse, StartTimerRequest, StopTimerBody, StopTimerResponse, SwitchTimerBody, SwitchTimerResponse, TimerStateResponse } from '@timekeeper/contracts';
import { ApiRequestError } from '../api-error.ts';
import { writeEntry } from '../entries/store.ts';
import { timedInterval } from '../entries/timed-entry.ts';
import { resolveWorkSettings, workAssociation, workRelations } from '../entries/work-settings.ts';
import type { WorkSettings } from '../entries/work-settings.ts';
import type { Prisma, PrismaClient } from '../generated/prisma/client.ts';
import { writeWithReceipt } from '../operation-receipt.ts';
import { continueEntryPreview, resolveContinuation } from './continuation.ts';

type TimerWithRelations = Prisma.RunningTimerGetPayload<{ include: typeof workRelations }>;

function runningTimerResponse(timer: TimerWithRelations): RunningTimerResponse {
	return {
		id: timer.id, revision: timer.revision, startAt: timer.startAt.toISOString(), description: timer.description,
		...workAssociation(timer), billable: timer.billable, assignedRateOrePerHour: timer.assignedRateOrePerHour?.toString() ?? null,
	};
}

function wholeSecond(date: Date): Date {
	return new Date(Math.floor(date.getTime() / 1_000) * 1_000);
}

function startRequestIdentity(input: StartTimerRequest) {
	if ('entryId' in input) {
		return ['timer.continue', input.entryId, input.entryRevision, input.rateChoice, input.expectedDefaultRateOrePerHour];
	}
	const { description, projectId, directClientId, rateOverrideOrePerHour, billable } = input;
	return ['timer.start', description?.trim() ?? '', projectId, directClientId, rateOverrideOrePerHour, billable ?? null];
}

function startWork(transaction: Prisma.TransactionClient, accountId: string, input: StartTimerRequest) {
	return 'entryId' in input
		? resolveContinuation(transaction, accountId, input)
		: resolveWorkSettings(transaction, accountId, input, true);
}

async function createRunningTimer(transaction: Prisma.TransactionClient, accountId: string, startAt: Date, work: WorkSettings) {
	const timer = await transaction.runningTimer.create({
		data: { accountId, id: randomUUID(), startAt, ...work }, include: workRelations,
	});
	return runningTimerResponse(timer);
}

async function currentTimer(transaction: Prisma.TransactionClient, accountId: string, { timerId, revision }: StopTimerBody) {
	const timer = await transaction.runningTimer.findUnique({ where: { accountId } });
	if (!timer || timer.id !== timerId || timer.revision !== revision) {
		throw new ApiRequestError(409, 'TIMER_CONFLICT', 'The timer changed. Refresh its state and try again.');
	}
	return timer;
}

async function closeRunningTimer(
	transaction: Prisma.TransactionClient, timer: Awaited<ReturnType<typeof currentTimer>>, endAt: Date, serverNow: Date, key: string,
): Promise<StopTimerResponse['entry']> {
	// Preserve the timer if the server clock has moved back, so elapsed time is not discarded.
	if (endAt < timer.startAt) {
		throw new ApiRequestError(409, 'TIMER_CLOCK_CONFLICT', 'The server clock is earlier than the timer start. The timer is still running.');
	}
	const time = timedInterval(timer.startAt, endAt, true);
	const { description, projectId, directClientId, billable, assignedRateOrePerHour, accountId, id, revision } = timer;
	const entry = await writeEntry(transaction, accountId, 'timed', time,
		{ description, projectId, directClientId, billable, assignedRateOrePerHour }, serverNow, { allowIncomplete: true, operationKey: key });
	if (entry.kind !== 'timed') throw new Error('Invalid stopped timer entry');
	await transaction.runningTimer.delete({ where: { accountId, id, revision } });
	return entry;
}

export function createTimerStore(database: PrismaClient, now: () => Date = () => new Date()) {

	return {
		async getState(accountId: string): Promise<TimerStateResponse> {
			const timer = await database.$transaction((transaction) => transaction.runningTimer.findUnique({
				where: { accountId }, include: workRelations,
			}));
			return { timer: timer ? runningTimerResponse(timer) : null, serverNow: now().toISOString() };
		},

		previewContinuation(accountId: string, entryId: string) {
			return database.$transaction((transaction) => continueEntryPreview(transaction, accountId, entryId));
		},

		start(accountId: string, key: string, input: StartTimerRequest): Promise<TimerStateResponse> {
			return writeWithReceipt(database, accountId, key, startRequestIdentity(input), parseTimerStateResponse, async (transaction) => {
				if (await transaction.runningTimer.findUnique({ where: { accountId }, select: { id: true } })) {
					throw new ApiRequestError(409, 'TIMER_RUNNING', 'A timer is already running.');
				}
				const work = await startWork(transaction, accountId, input);
				const serverNow = now();
				const timer = await createRunningTimer(transaction, accountId, wholeSecond(serverNow), work);
				return { timer, serverNow: serverNow.toISOString() };
			});
		},

		stop(accountId: string, key: string, input: StopTimerBody): Promise<StopTimerResponse> {
			const { timerId, revision } = input;
			return writeWithReceipt(database, accountId, key, ['timer.stop', timerId, revision], parseStopTimerResponse, async (transaction) => {
				const timer = await currentTimer(transaction, accountId, input);
				const serverNow = now();
				const entry = await closeRunningTimer(transaction, timer, wholeSecond(serverNow), serverNow, key);
				return { entry, serverNow: serverNow.toISOString() };
			});
		},

		switchTimer(accountId: string, key: string, input: SwitchTimerBody): Promise<SwitchTimerResponse> {
			const request = ['timer.switch', input.timerId, input.revision, ...startRequestIdentity(input.next)];
			return writeWithReceipt(database, accountId, key, request, parseSwitchTimerResponse, async (transaction) => {
				const current = await currentTimer(transaction, accountId, input);
				const next = await startWork(transaction, accountId, input.next);
				const serverNow = now();
				const boundary = wholeSecond(serverNow);
				const entry = await closeRunningTimer(transaction, current, boundary, serverNow, key);
				const timer = await createRunningTimer(transaction, accountId, boundary, next);
				return { entry, timer, serverNow: serverNow.toISOString() };
			});
		},
	};
}

export type TimerStore = ReturnType<typeof createTimerStore>;
