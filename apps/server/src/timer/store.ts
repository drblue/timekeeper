import { createHash, randomUUID } from 'node:crypto';
import { parseStopTimerResponse, parseTimerStateResponse } from '@timekeeper/contracts';
import type { RunningTimerResponse, StartTimerBody, StopTimerBody, StopTimerResponse, TimerStateResponse } from '@timekeeper/contracts';
import { writeForAccount } from '../account-write.ts';
import { ApiRequestError } from '../api-error.ts';
import { writeEntry } from '../entries/store.ts';
import { timedInterval } from '../entries/timed-entry.ts';
import { resolveWorkSettings, workAssociation, workRelations } from '../entries/work-settings.ts';
import type { Prisma, PrismaClient } from '../generated/prisma/client.ts';

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

export function createTimerStore(database: PrismaClient, now: () => Date = () => new Date()) {
	function transition<T extends TimerStateResponse | StopTimerResponse>(
		accountId: string, key: string, request: readonly unknown[],
		parse: (value: unknown) => T, run: (transaction: Prisma.TransactionClient) => Promise<T>,
	) {
		const requestHash = createHash('sha256').update(JSON.stringify(request)).digest('hex');
		return writeForAccount(database, accountId, async (transaction) => {
			const receipt = await transaction.operationReceipt.findUnique({ where: { accountId_key: { accountId, key } } });
			if (receipt) {
				if (receipt.requestHash !== requestHash) {
					throw new ApiRequestError(409, 'IDEMPOTENCY_CONFLICT', 'This operation ID was already used for a different request.');
				}
				return parse(JSON.parse(receipt.resultSnapshot));
			}
			const result = await run(transaction);
			parse(result);
			await transaction.operationReceipt.create({ data: {
				accountId, key, requestHash, resultSnapshot: JSON.stringify(result), completedAt: new Date(result.serverNow),
			} });
			return result;
		});
	}

	return {
		async getState(accountId: string): Promise<TimerStateResponse> {
			const timer = await database.$transaction((transaction) => transaction.runningTimer.findUnique({
				where: { accountId }, include: workRelations,
			}));
			return { timer: timer ? runningTimerResponse(timer) : null, serverNow: now().toISOString() };
		},

		start(accountId: string, key: string, input: StartTimerBody): Promise<TimerStateResponse> {
			const { description, projectId, directClientId, rateOverrideOrePerHour, billable } = input;
			const request = ['timer.start', description?.trim() ?? '', projectId, directClientId, rateOverrideOrePerHour, billable ?? null];
			return transition(accountId, key, request, parseTimerStateResponse, async (transaction) => {
				if (await transaction.runningTimer.findUnique({ where: { accountId }, select: { id: true } })) {
					throw new ApiRequestError(409, 'TIMER_RUNNING', 'A timer is already running.');
				}
				const work = await resolveWorkSettings(transaction, accountId, input, true);
				const serverNow = now();
				const timer = await transaction.runningTimer.create({
					data: { accountId, id: randomUUID(), startAt: wholeSecond(serverNow), ...work }, include: workRelations,
				});
				return { timer: runningTimerResponse(timer), serverNow: serverNow.toISOString() };
			});
		},

		stop(accountId: string, key: string, input: StopTimerBody): Promise<StopTimerResponse> {
			const { timerId, revision } = input;
			return transition(accountId, key, ['timer.stop', timerId, revision], parseStopTimerResponse, async (transaction) => {
				const timer = await transaction.runningTimer.findUnique({ where: { accountId } });
				if (!timer || timer.id !== timerId || timer.revision !== revision) {
					throw new ApiRequestError(409, 'TIMER_CONFLICT', 'The timer changed. Refresh its state and try again.');
				}
				const serverNow = now();
				// Preserve the timer if the server clock has moved back, so elapsed time is not discarded.
				const endAt = wholeSecond(serverNow);
				if (endAt < timer.startAt) {
					throw new ApiRequestError(409, 'TIMER_CLOCK_CONFLICT', 'The server clock is earlier than the timer start. The timer is still running.');
				}
				const time = timedInterval(timer.startAt, endAt, true);
				const { description, projectId, directClientId, billable, assignedRateOrePerHour } = timer;
				const entry = await writeEntry(transaction, accountId, 'timed', time,
					{ description, projectId, directClientId, billable, assignedRateOrePerHour }, serverNow, { key });
				if (entry.kind !== 'timed') throw new Error('Invalid stopped timer entry');
				await transaction.runningTimer.delete({ where: { accountId, id: timerId, revision } });
				return { entry, serverNow: serverNow.toISOString() };
			});
		},
	};
}

export type TimerStore = ReturnType<typeof createTimerStore>;
