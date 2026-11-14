import type { EntryResponse, IncompleteEntryResponse } from '@timekeeper/contracts';
import { ApiRequestError } from '../api-error.ts';
import { calculateBillableAmountOre, maxStoredOre } from '../billing.ts';
import type { Prisma } from '../generated/prisma/client.ts';
import { workAssociation, workRelations } from './work-settings.ts';
import type { WorkSettings } from './work-settings.ts';

export const entryRelations = {
	...workRelations,
	allocations: { orderBy: { localDate: 'asc' }, select: { localDate: true, seconds: true, amountOre: true, calculationVersion: true } },
} as const;

export type EntryWithRelations = Prisma.EntryGetPayload<{ include: typeof entryRelations }>;

export function activeEntryWhere(accountId: string) {
	return { accountId, deletedAt: null, supersededAt: null } satisfies Prisma.EntryWhereInput;
}

export function checkEntryRevision(current: { revision: number }, revision: number) {
	if (current.revision !== revision) throw new ApiRequestError(409, 'REVISION_CONFLICT', 'Time entry changed. Reload and try again.');
}

export function entryResponse(entry: EntryWithRelations): EntryResponse {
	const fields = {
		id: entry.id,
		description: entry.description,
		localDate: entry.localDate,
		durationSeconds: entry.durationSeconds,
		...workAssociation(entry),
		billable: entry.billable,
		assignedRateOrePerHour: entry.assignedRateOrePerHour?.toString() ?? null,
		revision: entry.revision,
		...(entry.invoicedAt ? { invoicedAt: entry.invoicedAt.toISOString() } : {}),
		...(entry.invoiceNumber !== null ? { invoiceNumber: entry.invoiceNumber } : {}),
		...(entry.invoiceDate !== null ? { invoiceDate: entry.invoiceDate } : {}),
		...(entry.invoiceReference !== null ? { invoiceReference: entry.invoiceReference } : {}),
		...(entry.deletedAt ? { deletedAt: entry.deletedAt.toISOString() } : {}),
		...(entry.supersededAt ? { supersededAt: entry.supersededAt.toISOString() } : {}),
		...(entry.splitFromEntryId ? { splitFromEntryId: entry.splitFromEntryId } : {}),
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

export function entryBilling(work: WorkSettings, durationSeconds: number) {
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

export function requireCompleteAmount(billing: ReturnType<typeof entryBilling>): bigint {
	if (billing.missingFields.includes('rate')) {
		throw new ApiRequestError(422, 'MISSING_HOURLY_RATE', 'Enter an hourly rate for billable work.', 'rateOverrideOrePerHour');
	}
	if (billing.missingFields.includes('amount')) {
		throw new ApiRequestError(422, 'AMOUNT_OUT_OF_RANGE', 'The duration and rate produce an amount above the supported maximum.');
	}
	if (billing.billableAmountOre === null) throw new Error('Invalid completed entry');
	return billing.billableAmountOre;
}
