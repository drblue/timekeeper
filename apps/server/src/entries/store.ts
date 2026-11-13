import { randomUUID } from 'node:crypto';
import { maxEntryDescriptionLength } from '@timekeeper/contracts';
import type { CreateEntryBody, EntryResponse } from '@timekeeper/contracts';
import { writeForAccount } from '../account-write.ts';
import { ApiRequestError } from '../api-error.ts';
import { calculateBillableAmountOre, maxStoredOre, parseHourlyRateOre } from '../billing.ts';
import { activeProjectWhere, effectiveProjectHourlyRate } from '../catalog/project.ts';
import type { Prisma, PrismaClient } from '../generated/prisma/client.ts';
import { allocateEntryAmount, manualTimedInterval } from './timed-entry.ts';

const allocationCalculationVersion = 1;
const clientName = { select: { id: true, name: true } } as const;
const entryRelations = {
	project: { select: { name: true, client: clientName } },
	directClient: clientName,
	allocations: { orderBy: { localDate: 'asc' }, select: { localDate: true, seconds: true, amountOre: true } },
} as const;

type EntryWithRelations = Prisma.EntryGetPayload<{ include: typeof entryRelations }>;

function entryResponse(entry: EntryWithRelations): EntryResponse {
	const client = entry.project?.client ?? entry.directClient;
	const fields = {
		id: entry.id,
		description: entry.description,
		localDate: entry.localDate,
		durationSeconds: entry.durationSeconds,
		projectId: entry.projectId,
		directClientId: entry.directClientId,
		clientId: client?.id ?? null,
		projectName: entry.project?.name ?? null,
		clientName: client?.name ?? null,
		billable: entry.billable,
		assignedRateOrePerHour: entry.assignedRateOrePerHour?.toString() ?? null,
		billableAmountOre: entry.billableAmountOre.toString(),
		revision: entry.revision,
	};
	if (entry.kind === 'duration-only') return { kind: entry.kind, ...fields };
	if (entry.kind !== 'timed' || !entry.startAt || !entry.endAt) {
		throw new Error('Invalid timed entry');
	}
	return {
		kind: entry.kind,
		...fields,
		startAt: entry.startAt.toISOString(),
		endAt: entry.endAt.toISOString(),
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

async function billingDefaults(
	transaction: Prisma.TransactionClient, accountId: string, projectId: string | null, directClientId: string | null,
): Promise<{ billable: boolean; rateOrePerHour: bigint | null }> {
	if (projectId !== null) {
		const project = await transaction.project.findUnique({
			where: { id: projectId, ...activeProjectWhere(accountId) },
			select: {
				defaultBillable: true,
				rateOverrideOrePerHour: true,
				client: { select: { defaultRateOrePerHour: true } },
			},
		});
		if (!project) {
			throw new ApiRequestError(422, 'INVALID_PROJECT', 'Choose an active project.', 'projectId');
		}
		return { billable: project.defaultBillable, rateOrePerHour: effectiveProjectHourlyRate(project) };
	}
	if (directClientId !== null) {
		const client = await transaction.client.findUnique({
			where: { id: directClientId, accountId, archivedAt: null },
			select: { defaultRateOrePerHour: true },
		});
		if (!client) {
			throw new ApiRequestError(422, 'INVALID_CLIENT', 'Choose an active client.', 'directClientId');
		}
		return { billable: true, rateOrePerHour: client.defaultRateOrePerHour };
	}
	return { billable: false, rateOrePerHour: null };
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
			const { kind, projectId, directClientId } = input;
			const description = input.description.trim();
			if (!description || [...description].length > maxEntryDescriptionLength) {
				throw new ApiRequestError(422, 'INVALID_DESCRIPTION', 'Enter a description for the work.', 'description');
			}
			const { localDate, durationSeconds, startAt, endAt, segments } = entryTime(input);
			if (projectId !== null && directClientId !== null) {
				throw new ApiRequestError(422, 'INVALID_ASSOCIATION', 'Choose a project or a direct client.', 'directClientId');
			}
			const rateOverride = parseHourlyRateOre(input.rateOverrideOrePerHour, 'rateOverrideOrePerHour');

			return writeForAccount(database, accountId, async (transaction) => {
				const defaults = await billingDefaults(transaction, accountId, projectId, directClientId);
				const billable = input.billable ?? defaults.billable;
				const assignedRateOrePerHour = rateOverride ?? defaults.rateOrePerHour;
				let billableAmountOre = 0n;
				if (billable) {
					if (assignedRateOrePerHour === null) {
						throw new ApiRequestError(422, 'MISSING_HOURLY_RATE', 'Enter an hourly rate for billable work.', 'rateOverrideOrePerHour');
					}
					billableAmountOre = calculateBillableAmountOre(durationSeconds, assignedRateOrePerHour);
					if (billableAmountOre > maxStoredOre) {
						throw new ApiRequestError(422, 'AMOUNT_OUT_OF_RANGE', 'The duration and rate produce an amount above the supported maximum.');
					}
				}

				if (input.kind === 'timed' && startAt && endAt && !input.confirmOverlap) {
					const overlap = await transaction.entry.findFirst({
						where: { accountId, kind: 'timed', startAt: { lt: endAt }, endAt: { gt: startAt } },
						select: { id: true },
					});
					if (overlap) {
						throw new ApiRequestError(409, 'ENTRY_OVERLAP', 'The time overlaps recorded work. Confirm to save this entry.');
					}
				}
				const allocations = allocateEntryAmount(segments, durationSeconds, billableAmountOre)
					.map((allocation) => ({ ...allocation, calculationVersion: allocationCalculationVersion }));
				const entry = await transaction.entry.create({
					data: {
						id: randomUUID(), accountId, kind, description, localDate, durationSeconds, projectId, directClientId,
						startAt, endAt,
						billable, assignedRateOrePerHour, billableAmountOre, createdAt: new Date(),
						allocations: { createMany: { data: allocations } },
					},
					include: entryRelations,
				});
				return entryResponse(entry);
			});
		},
	};
}

export type EntryStore = ReturnType<typeof createEntryStore>;
