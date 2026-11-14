import { randomUUID } from 'node:crypto';
import { parseEntryHistoryAction } from '@timekeeper/contracts';
import type { CompleteEntryBody, CreateEntryBody, EntryEditBody, EntryEditPreview, EntryEditTime, EntryHistoryResponse, EntryResponse, EntryTrashResponse, TimedEntryResponse, TrashedEntryResponse } from '@timekeeper/contracts';
import { writeForAccount } from '../account-write.ts';
import { ApiRequestError } from '../api-error.ts';
import { parseHourlyRateOre } from '../billing.ts';
import type { Prisma, PrismaClient } from '../generated/prisma/client.ts';
import { allocateEntryAmount, manualTimedInterval, timedInterval } from './timed-entry.ts';
import type { EntryDaySegment } from './timed-entry.ts';
import { billingDefaults, resolveWorkSettings, validateWorkAssociation, workDescription } from './work-settings.ts';
import type { WorkSettings } from './work-settings.ts';
import { createWorkList } from './work-list.ts';
import { activeEntryWhere, checkEntryRevision, entryBilling, entryRelations, entryResponse, requireCompleteAmount } from './entry-record.ts';
import type { EntryWithRelations } from './entry-record.ts';
import { readHistorySnapshot, recordHistory } from './entry-history.ts';
import { validLocalDate } from '../local-date.ts';
import { createEntryInvoiceStore } from './invoicing.ts';
import { createBulkEntryStore } from './bulk.ts';
import { changeEntryDeletion, requireUninvoicedEntry } from './entry-deletion.ts';

const allocationCalculationVersion = 1;
const trashRetentionMs = 30 * 24 * 60 * 60 * 1_000;
function entryTime(input: EntryEditTime): EntryTime {
	if (input.kind === 'timed') return manualTimedInterval(input);
	const { localDate, durationSeconds } = input;
	if (!validLocalDate(localDate)) throw new ApiRequestError(422, 'INVALID_LOCAL_DATE', 'Enter a valid calendar date.', 'localDate');
	return { localDate, durationSeconds, startAt: null, endAt: null, segments: [{ localDate, seconds: durationSeconds }] };
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

async function editableEntry(transaction: Prisma.TransactionClient, accountId: string, id: string, revision: number) {
	const current = await transaction.entry.findUnique({ where: { id, ...activeEntryWhere(accountId) }, include: entryRelations });
	if (!current) throw new ApiRequestError(404, 'NOT_FOUND', 'Time entry was not found.');
	requireUninvoicedEntry(current, 'editing');
	checkEntryRevision(current, revision);
	return current;
}

function trashedEntryResponse(entry: EntryResponse): TrashedEntryResponse {
	if (!entry.deletedAt) throw new Error('Trashed entry did not have a deletion date.');
	return { entry, deletedAt: entry.deletedAt, restoreUntil: new Date(Date.parse(entry.deletedAt) + trashRetentionMs).toISOString() };
}

function savedTime(current: EntryWithRelations): EntryTime {
	if (current.startAt && current.endAt) return timedInterval(current.startAt, current.endAt);
	const { localDate, durationSeconds } = current;
	return { localDate, durationSeconds, startAt: null, endAt: null, segments: [{ localDate, seconds: durationSeconds }] };
}

async function overlappingEntry(transaction: Prisma.TransactionClient, accountId: string, time: EntryTime, except?: string) {
	if (!time.startAt || !time.endAt) return false;
	return Boolean(await transaction.entry.findFirst({
		where: { ...activeEntryWhere(accountId), id: except ? { not: except } : undefined, kind: 'timed', durationSeconds: { gt: 0 },
			startAt: { lt: time.endAt }, endAt: { gt: time.startAt } },
		select: { id: true },
	}));
}

function requireOverlapConfirmation(overlap: boolean, confirmed: boolean | undefined) {
	if (overlap && !confirmed) {
		throw new ApiRequestError(409, 'ENTRY_OVERLAP', 'The time overlaps recorded work. Confirm to save this entry.');
	}
}

async function prepareEdit(
	transaction: Prisma.TransactionClient, accountId: string, current: EntryWithRelations, input: EntryEditBody, proposedTime: EntryTime | undefined,
) {
	const { projectId, directClientId, billable, rate } = input;
	const description = workDescription(input.description);
	validateWorkAssociation(projectId, directClientId);
	const associationChanged = projectId !== current.projectId || directClientId !== current.directClientId;
	const defaults = associationChanged || rate?.mode === 'current'
		? await billingDefaults(transaction, accountId, projectId, directClientId)
		: null;
	let assignedRateOrePerHour = current.assignedRateOrePerHour;
	if (rate?.mode === 'current') {
		assignedRateOrePerHour = defaults?.rateOrePerHour ?? null;
		if ((assignedRateOrePerHour?.toString() ?? null) !== rate.expectedDefaultRateOrePerHour) {
			throw new ApiRequestError(409, 'ENTRY_DEFAULT_RATE_CHANGED', 'The default hourly rate changed. Reload and review the entry.');
		}
	} else if (rate?.mode === 'override') {
		assignedRateOrePerHour = parseHourlyRateOre(rate.rateOrePerHour, 'rate/rateOrePerHour');
	}
	if (!proposedTime && current.durationSeconds === 0) {
		throw new ApiRequestError(422, 'INVALID_DURATION', 'Enter a positive duration for this time entry.', 'time');
	}
	const work = { description, projectId, directClientId, billable, assignedRateOrePerHour };
	const kind = input.time?.kind ?? (current.startAt ? 'timed' : 'duration-only');
	const timeChanged = Boolean(proposedTime && (
		kind !== current.kind || proposedTime.localDate !== current.localDate || proposedTime.durationSeconds !== current.durationSeconds
		|| proposedTime.startAt?.getTime() !== current.startAt?.getTime() || proposedTime.endAt?.getTime() !== current.endAt?.getTime()
	));
	const billingChanged = billable !== current.billable || assignedRateOrePerHour !== current.assignedRateOrePerHour;
	const billableAmountOre = billingChanged || current.billableAmountOre === null
		|| (proposedTime && proposedTime.durationSeconds !== current.durationSeconds)
		? requireCompleteAmount(entryBilling(work, proposedTime?.durationSeconds ?? current.durationSeconds))
		: current.billableAmountOre;
	const rebuild = timeChanged || billingChanged || current.completion !== 'complete';
	const time = rebuild ? proposedTime ?? savedTime(current) : null;
	const overlap = timeChanged && proposedTime !== undefined && await overlappingEntry(transaction, accountId, proposedTime, current.id);
	return { work, kind, time, billableAmountOre, overlap, changed: rebuild || associationChanged || description !== current.description };
}

async function replaceEntry(
	transaction: Prisma.TransactionClient, current: EntryWithRelations, kind: EntryResponse['kind'], work: WorkSettings,
	billableAmountOre: bigint, time: EntryTime | null,
): Promise<EntryResponse> {
	const { id, accountId, revision } = current;
	if (time) await transaction.entryDayAllocation.deleteMany({ where: { entryId: id } });
	const updated = await transaction.entry.update({
		where: { id, ...activeEntryWhere(accountId), revision, invoicedAt: null },
		data: {
			kind, ...work, billableAmountOre, completion: 'complete', revision: { increment: 1 },
			...(time ? {
				localDate: time.localDate, durationSeconds: time.durationSeconds, startAt: time.startAt, endAt: time.endAt,
				allocations: { createMany: { data: completedAllocations(time, billableAmountOre) } },
			} : {}),
		},
		include: entryRelations,
	});
	const response = entryResponse(updated);
	await recordHistory(transaction, current.completion === 'incomplete' ? 'completed' : 'edited', new Date(), response, entryResponse(current));
	return response;
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

export function createEntryStore(database: PrismaClient, now: () => Date = () => new Date()) {
	return {
		getWorkList: createWorkList(database, now),
		...createEntryInvoiceStore(database, now),
		...createBulkEntryStore(database, now),
		async listEntries(accountId: string): Promise<EntryResponse[]> {
			const entries = await database.$transaction((transaction) => transaction.entry.findMany({
				where: activeEntryWhere(accountId),
				include: entryRelations,
				orderBy: [{ localDate: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
			}));
			return entries.map(entryResponse);
		},

		async getEntry(accountId: string, id: string): Promise<EntryResponse> {
			const entry = await database.$transaction((transaction) => transaction.entry.findUnique({
				where: { id, ...activeEntryWhere(accountId) }, include: entryRelations,
			}));
			if (!entry) {
				throw new ApiRequestError(404, 'NOT_FOUND', 'Time entry was not found.');
			}
			return entryResponse(entry);
		},

		async listTrash(accountId: string): Promise<EntryTrashResponse> {
			const cutoff = new Date(now().getTime() - trashRetentionMs);
			const entries = await database.$transaction((transaction) => transaction.entry.findMany({
				where: { accountId, deletedAt: { gt: cutoff } }, include: entryRelations,
				orderBy: [{ deletedAt: 'desc' }, { id: 'desc' }],
			}));
			return entries.map((entry) => trashedEntryResponse(entryResponse(entry)));
		},

		deleteEntry(accountId: string, id: string, revision: number): Promise<TrashedEntryResponse> {
			return writeForAccount(database, accountId, async (transaction) => {
				const current = await transaction.entry.findUnique({ where: { id, accountId }, include: entryRelations });
				if (!current) throw new ApiRequestError(404, 'NOT_FOUND', 'Time entry was not found.');
				requireUninvoicedEntry(current, 'deleting');
				checkEntryRevision(current, revision);
				if (current.deletedAt) throw new ApiRequestError(409, 'ENTRY_ALREADY_DELETED', 'This time entry is already in the trash.');
				const deletedAt = now();
				return trashedEntryResponse(await changeEntryDeletion(transaction, current, deletedAt, deletedAt));
			});
		},

		restoreEntry(accountId: string, id: string, revision: number): Promise<EntryResponse> {
			return writeForAccount(database, accountId, async (transaction) => {
				const current = await transaction.entry.findUnique({ where: { id, accountId }, include: entryRelations });
				if (!current) throw new ApiRequestError(404, 'NOT_FOUND', 'Time entry was not found.');
				checkEntryRevision(current, revision);
				if (!current.deletedAt) throw new ApiRequestError(409, 'ENTRY_NOT_DELETED', 'This time entry is no longer in the trash.');
				const restoredAt = now();
				if (restoredAt.getTime() >= current.deletedAt.getTime() + trashRetentionMs) {
					throw new ApiRequestError(409, 'ENTRY_RESTORE_EXPIRED', 'The 30-day restore period has ended.');
				}
				return changeEntryDeletion(transaction, current, null, restoredAt);
			});
		},

		createEntry(accountId: string, input: CreateEntryBody): Promise<EntryResponse> {
			const time = entryTime(input);

			return writeForAccount(database, accountId, async (transaction) => {
				const work = await resolveWorkSettings(transaction, accountId, input);
				if (input.kind === 'timed' && !input.confirmOverlap) {
					requireOverlapConfirmation(await overlappingEntry(transaction, accountId, time), input.confirmOverlap);
				}
				return writeEntry(transaction, accountId, input.kind, time, work, new Date());
			});
		},

		async getHistory(accountId: string, id: string): Promise<EntryHistoryResponse> {
			return database.$transaction(async (transaction) => {
				const owner = await transaction.entry.findUnique({ where: { id, ...activeEntryWhere(accountId) }, select: { id: true } });
				if (!owner) throw new ApiRequestError(404, 'NOT_FOUND', 'Time entry was not found.');
				const rows = await transaction.entryHistory.findMany({ where: { entryId: id }, orderBy: [{ at: 'desc' }, { id: 'desc' }] });
				return rows.map(({ id: historyId, action, at, beforeSnapshot, afterSnapshot }) => {
					return { id: historyId, action: parseEntryHistoryAction(action), at: at.toISOString(),
						before: beforeSnapshot === null ? null : readHistorySnapshot(beforeSnapshot, id), after: readHistorySnapshot(afterSnapshot, id) };
				});
			});
		},

		previewEdit(accountId: string, id: string, input: EntryEditBody): Promise<EntryEditPreview> {
			const proposedTime = input.time ? entryTime(input.time) : undefined;
			return database.$transaction(async (transaction) => {
				const current = await editableEntry(transaction, accountId, id, input.revision);
				const { billableAmountOre, work, overlap } = await prepareEdit(transaction, accountId, current, input, proposedTime);
				return {
					durationSeconds: proposedTime?.durationSeconds ?? current.durationSeconds,
					billableAmountOre: billableAmountOre.toString(), assignedRateOrePerHour: work.assignedRateOrePerHour?.toString() ?? null, overlap,
				};
			});
		},

		updateEntry(accountId: string, id: string, input: EntryEditBody): Promise<EntryResponse> {
			const proposedTime = input.time ? entryTime(input.time) : undefined;
			return writeForAccount(database, accountId, async (transaction) => {
				const current = await editableEntry(transaction, accountId, id, input.revision);
				const edit = await prepareEdit(transaction, accountId, current, input, proposedTime);
				requireOverlapConfirmation(edit.overlap, input.confirmOverlap);
				if (!edit.changed) return entryResponse(current);
				return replaceEntry(transaction, current, edit.kind, edit.work, edit.billableAmountOre, edit.time);
			});
		},

		completeEntry(accountId: string, id: string, input: CompleteEntryBody): Promise<TimedEntryResponse> {
			const description = workDescription(input.description);
			const rateOverride = parseHourlyRateOre(input.rateOverrideOrePerHour, 'rateOverrideOrePerHour');
			return writeForAccount(database, accountId, async (transaction) => {
				const current = await editableEntry(transaction, accountId, id, input.revision);
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
				const response = await replaceEntry(transaction, current, 'timed', work, billableAmountOre, time);
				if (response.kind !== 'timed' || response.completion !== 'complete') throw new Error('Invalid completed timer entry');
				return response;
			});
		},
	};
}

export type EntryStore = ReturnType<typeof createEntryStore>;
