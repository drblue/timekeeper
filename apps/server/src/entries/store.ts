import { randomUUID } from 'node:crypto';
import type { CompleteEntryBody, CreateEntryBody, EntryResponse, IncompleteEntryResponse, TimedEntryResponse } from '@timekeeper/contracts';
import { writeForAccount } from '../account-write.ts';
import { ApiRequestError } from '../api-error.ts';
import { calculateBillableAmountOre, maxStoredOre, parseHourlyRateOre } from '../billing.ts';
import type { Prisma, PrismaClient } from '../generated/prisma/client.ts';
import { allocateEntryAmount, manualTimedInterval, timedInterval } from './timed-entry.ts';
import type { EntryDaySegment } from './timed-entry.ts';
import { resolveWorkSettings, workAssociation, workDescription, workRelations } from './work-settings.ts';
import type { WorkSettings } from './work-settings.ts';

const allocationCalculationVersion = 1;
const entryRelations = {
	...workRelations,
	allocations: { orderBy: { localDate: 'asc' }, select: { localDate: true, seconds: true, amountOre: true } },
} as const;

type EntryWithRelations = Prisma.EntryGetPayload<{ include: typeof entryRelations }>;

function entryResponse(entry: EntryWithRelations): EntryResponse {
	const fields = {
		id: entry.id,
		description: entry.description,
		localDate: entry.localDate,
		durationSeconds: entry.durationSeconds,
		...workAssociation(entry),
		billable: entry.billable,
		assignedRateOrePerHour: entry.assignedRateOrePerHour?.toString() ?? null,
		revision: entry.revision,
	};
	if (entry.kind === 'duration-only' && entry.completion === 'complete' && entry.billableAmountOre !== null) {
		return { kind: entry.kind, completion: 'complete', ...fields, billableAmountOre: entry.billableAmountOre.toString() };
	}
	if (entry.kind !== 'timed' || !entry.startAt || !entry.endAt) {
		throw new Error('Invalid timed entry');
	}
	const timed = {
		kind: 'timed' as const,
		...fields,
		startAt: entry.startAt.toISOString(),
		endAt: entry.endAt.toISOString(),
	};
	if (entry.completion === 'incomplete') {
		const { missingFields } = entryBilling(entry, entry.durationSeconds);
		return { ...timed, completion: 'incomplete', billableAmountOre: null, allocations: [], missingFields };
	}
	if (entry.billableAmountOre === null || entry.completion !== 'complete') throw new Error('Invalid entry completion');
	return {
		...timed, completion: 'complete', billableAmountOre: entry.billableAmountOre.toString(),
		allocations: entry.allocations.map(({ localDate, seconds, amountOre }) => ({ localDate, seconds, amountOre: amountOre.toString() })),
	};
}

function checkLocalDate(localDate: string) {
	const year = Number(localDate.slice(0, 4));
	const month = Number(localDate.slice(5, 7));
	const day = Number(localDate.slice(8, 10));
	const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
	const monthDays = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
	if (year === 0 || day < 1 || day > (monthDays[month - 1] ?? 0)) {
		throw new ApiRequestError(422, 'INVALID_LOCAL_DATE', 'Enter a valid calendar date.', 'localDate');
	}
}

function entryTime(input: CreateEntryBody) {
	if (input.kind === 'timed') return manualTimedInterval(input);
	const { localDate, durationSeconds } = input;
	checkLocalDate(localDate);
	return { localDate, durationSeconds, startAt: null, endAt: null, segments: [{ localDate, seconds: durationSeconds }] };
}

function entryBilling(work: WorkSettings, durationSeconds: number) {
	const missingFields: IncompleteEntryResponse['missingFields'] = [];
	if (!work.description) missingFields.push('description');
	if (durationSeconds === 0) missingFields.push('duration');
	let amount = 0n;
	if (work.billable) {
		if (work.assignedRateOrePerHour === null) {
			missingFields.push('rate');
		} else if (durationSeconds > 0) {
			amount = calculateBillableAmountOre(durationSeconds, work.assignedRateOrePerHour);
			if (amount > maxStoredOre) missingFields.push('amount');
		}
	}
	return { missingFields, billableAmountOre: missingFields.length ? null : amount };
}

function requireCompleteAmount(billing: ReturnType<typeof entryBilling>): bigint {
	if (billing.missingFields.includes('rate')) {
		throw new ApiRequestError(422, 'MISSING_HOURLY_RATE', 'Enter an hourly rate for billable work.', 'rateOverrideOrePerHour');
	}
	if (billing.missingFields.includes('amount')) {
		throw new ApiRequestError(422, 'AMOUNT_OUT_OF_RANGE', 'The duration and rate produce an amount above the supported maximum.');
	}
	if (billing.billableAmountOre === null) throw new Error('Invalid completed entry');
	return billing.billableAmountOre;
}

function completedAllocations(time: EntryTime, billableAmountOre: bigint) {
	return allocateEntryAmount(time.segments, time.durationSeconds, billableAmountOre)
		.map((allocation) => ({ ...allocation, calculationVersion: allocationCalculationVersion }));
}

interface EntryTime {
	localDate: string;
	durationSeconds: number;
	startAt: Date | null;
	endAt: Date | null;
	segments: EntryDaySegment[];
}

async function recordHistory(
	transaction: Prisma.TransactionClient, action: 'created' | 'completed', at: Date,
	after: EntryResponse, before?: EntryResponse, operationKey?: string,
) {
	await transaction.entryHistory.create({ data: {
		id: randomUUID(), entryId: after.id, action, at, operationKey,
		beforeSnapshot: before ? JSON.stringify({ version: 1, entry: before }) : null,
		afterSnapshot: JSON.stringify({ version: 1, entry: after }),
	} });
}

export async function writeEntry(
	transaction: Prisma.TransactionClient, accountId: string, kind: EntryResponse['kind'], time: EntryTime,
	work: WorkSettings, createdAt: Date, timerOperation?: { key: string },
): Promise<EntryResponse> {
	const billing = entryBilling(work, time.durationSeconds);
	const billableAmountOre = timerOperation ? billing.billableAmountOre : requireCompleteAmount(billing);
	const { localDate, durationSeconds, startAt, endAt } = time;
	const entry = await transaction.entry.create({
		data: {
			id: randomUUID(), accountId, kind, localDate, durationSeconds, startAt, endAt, ...work,
			billableAmountOre, createdAt, completion: billableAmountOre === null ? 'incomplete' : 'complete',
			...(billableAmountOre === null ? {} : { allocations: { createMany: { data: completedAllocations(time, billableAmountOre) } } }),
		},
		include: entryRelations,
	});
	const response = entryResponse(entry);
	await recordHistory(transaction, 'created', createdAt, response, undefined, timerOperation?.key);
	return response;
}

export function createEntryStore(database: PrismaClient) {
	return {
		async listEntries(accountId: string): Promise<EntryResponse[]> {
			const entries = await database.$transaction((transaction) => transaction.entry.findMany({
				where: { accountId },
				include: entryRelations,
				orderBy: [{ localDate: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
			}));
			return entries.map(entryResponse);
		},

		async getEntry(accountId: string, id: string): Promise<EntryResponse> {
			const entry = await database.$transaction((transaction) => transaction.entry.findUnique({
				where: { id, accountId }, include: entryRelations,
			}));
			if (!entry) {
				throw new ApiRequestError(404, 'NOT_FOUND', 'Time entry was not found.');
			}
			return entryResponse(entry);
		},

		createEntry(accountId: string, input: CreateEntryBody): Promise<EntryResponse> {
			const time = entryTime(input);
			const { startAt, endAt } = time;

			return writeForAccount(database, accountId, async (transaction) => {
				const work = await resolveWorkSettings(transaction, accountId, input);
				if (input.kind === 'timed' && startAt && endAt && !input.confirmOverlap) {
					const overlap = await transaction.entry.findFirst({
						where: { accountId, kind: 'timed', durationSeconds: { gt: 0 }, startAt: { lt: endAt }, endAt: { gt: startAt } },
						select: { id: true },
					});
					if (overlap) {
						throw new ApiRequestError(409, 'ENTRY_OVERLAP', 'The time overlaps recorded work. Confirm to save this entry.');
					}
				}
				return writeEntry(transaction, accountId, input.kind, time, work, new Date());
			});
		},

		completeEntry(accountId: string, id: string, input: CompleteEntryBody): Promise<TimedEntryResponse> {
			const description = workDescription(input.description);
			const rateOverride = parseHourlyRateOre(input.rateOverrideOrePerHour, 'rateOverrideOrePerHour');
			return writeForAccount(database, accountId, async (transaction) => {
				const current = await transaction.entry.findUnique({ where: { id, accountId }, include: entryRelations });
				if (!current) throw new ApiRequestError(404, 'NOT_FOUND', 'Time entry was not found.');
				if (current.revision !== input.revision) throw new ApiRequestError(409, 'REVISION_CONFLICT', 'Time entry changed. Reload and try again.');
				if (current.completion !== 'incomplete' || !current.startAt || !current.endAt) {
					throw new ApiRequestError(409, 'ENTRY_ALREADY_COMPLETE', 'This time entry is already complete.');
				}
				if (current.durationSeconds === 0 ? input.durationSeconds === undefined : input.durationSeconds !== undefined) {
					throw new ApiRequestError(422, 'INVALID_DURATION', current.durationSeconds === 0
						? 'Enter a positive duration for this time entry.' : 'This time entry already has a recorded duration.', 'durationSeconds');
				}
				const endAt = input.durationSeconds === undefined ? current.endAt : new Date(current.startAt.getTime() + input.durationSeconds * 1_000);
				const time = timedInterval(current.startAt, endAt);
				const work = {
					description, projectId: current.projectId, directClientId: current.directClientId,
					billable: input.billable ?? current.billable,
					assignedRateOrePerHour: rateOverride ?? current.assignedRateOrePerHour,
				};
				const billableAmountOre = requireCompleteAmount(entryBilling(work, time.durationSeconds));
				const entry = await transaction.entry.update({
					where: { id, accountId, revision: input.revision },
					data: {
						...work, billableAmountOre, durationSeconds: time.durationSeconds, endAt, completion: 'complete', revision: { increment: 1 },
						allocations: { createMany: { data: completedAllocations(time, billableAmountOre) } },
					},
					include: entryRelations,
				});
				const response = entryResponse(entry);
				if (response.kind !== 'timed' || response.completion !== 'complete') throw new Error('Invalid completed timer entry');
				await recordHistory(transaction, 'completed', new Date(), response, entryResponse(current));
				return response;
			});
		},
	};
}

export type EntryStore = ReturnType<typeof createEntryStore>;
