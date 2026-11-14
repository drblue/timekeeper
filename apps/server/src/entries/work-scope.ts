import { nextStockholmDayStart, stockholmDateRange, stockholmDayStart } from '@timekeeper/contracts';
import type { WorkListQuery, WorkListRange } from '@timekeeper/contracts';
import { ApiRequestError } from '../api-error.ts';
import type { Prisma } from '../generated/prisma/client.ts';
import { activeEntryWhere } from './entry-record.ts';
import { workRelations } from './work-settings.ts';

type WorkFilters = Pick<WorkListQuery, 'clientId' | 'projectId' | 'invoice' | 'billability' | 'description' | 'invoiceNumber'>;

export interface WorkScope {
	range: WorkListRange;
	startAt: Date;
	endBefore: Date;
	entryWhere: Prisma.EntryWhereInput;
	clientName: string | null;
	projectName: string | null;
	matchesSearch: (entry: { description: string; invoiceNumber: string | null }) => boolean;
	incompatibleSelection: boolean;
}

function compareText(left: string, right: string) {
	return left < right ? -1 : left > right ? 1 : 0;
}

type OrderedWork = { localDate: string; entryId: string; entry: { startAt: Date | null; createdAt: Date } };

export function compareWorkRows(left: OrderedWork, right: OrderedWork) {
	return compareText(left.localDate, right.localDate)
		|| (left.entry.startAt ?? left.entry.createdAt).getTime() - (right.entry.startAt ?? right.entry.createdAt).getTime()
		|| compareText(left.entryId, right.entryId);
}

export function workDateRange(query: Pick<WorkListQuery, 'preset' | 'from' | 'to'>, now: string): WorkListRange {
	const { from, to } = query;
	const preset = query.preset ?? (from !== undefined || to !== undefined ? 'custom' : 'this-week');
	if (preset === 'custom') {
		if (!from || !to || from > to || from.startsWith('0000-') || to.startsWith('0000-')) {
			throw new ApiRequestError(422, 'INVALID_DATE_RANGE', 'Enter a valid start and end date in order.');
		}
		return { from, to };
	}
	if (from !== undefined || to !== undefined) {
		throw new ApiRequestError(422, 'INVALID_DATE_RANGE', 'Select Custom range to enter dates.');
	}
	return stockholmDateRange(preset, now);
}

function searchText(value: string) {
	return value.toLowerCase().normalize('NFC');
}

export async function resolveWorkScope(
	transaction: Prisma.TransactionClient, accountId: string, range: WorkListRange, filters: WorkFilters,
): Promise<WorkScope> {
	const { clientId, projectId, invoice, billability } = filters;
	let startAt: Date;
	let endBefore: Date;
	try {
		startAt = new Date(stockholmDayStart(range.from));
		endBefore = new Date(nextStockholmDayStart(range.to).epochMilliseconds);
	} catch (error) {
		if (error instanceof RangeError) throw new ApiRequestError(422, 'INVALID_DATE_RANGE', 'Enter valid Stockholm calendar dates.');
		throw error;
	}
	const client = clientId && await transaction.client.findUnique({ where: { id: clientId, accountId }, select: { name: true } });
	if (clientId && !client) {
		throw new ApiRequestError(422, 'INVALID_CLIENT', 'Choose a client from your work history.');
	}
	const project = projectId && await transaction.project.findUnique({ where: { id: projectId, accountId }, select: { clientId: true, name: true } });
	if (projectId && !project) throw new ApiRequestError(422, 'INVALID_PROJECT', 'Choose a project from your work history.');
	const incompatibleSelection = Boolean(clientId && project && project.clientId !== clientId);
	const conditions: Prisma.EntryWhereInput[] = [];
	if (clientId) conditions.push({ OR: [{ directClientId: clientId }, { project: { is: { accountId, clientId } } }] });
	if (invoice === 'invoiced') conditions.push({ invoicedAt: { not: null } });
	if (invoice === 'not-yet-invoiced') conditions.push({ invoicedAt: null, billable: true });
	if (billability === 'billable') conditions.push({ billable: true });
	if (billability === 'non-billable') conditions.push({ billable: false });
	const description = searchText(filters.description?.trim() ?? '');
	const invoiceNumber = searchText(filters.invoiceNumber?.trim() ?? '');
	return {
		range, startAt, endBefore, entryWhere: { ...activeEntryWhere(accountId), projectId, AND: conditions }, incompatibleSelection,
		clientName: client ? client.name : null, projectName: project ? project.name : null,
		matchesSearch(entry) {
			return (!description || searchText(entry.description).includes(description))
				&& (!invoiceNumber || (entry.invoiceNumber !== null && searchText(entry.invoiceNumber).includes(invoiceNumber)));
		},
	};
}

const workEntryFields = { description: true, invoiceNumber: true, startAt: true, createdAt: true } as const;
const reportEntryFields = { ...workEntryFields, ...workRelations, projectId: true, directClientId: true, assignedRateOrePerHour: true } as const;
const workAllocationFields = { entryId: true, localDate: true, seconds: true, amountOre: true } as const;
type CompletedWorkRow = Prisma.EntryDayAllocationGetPayload<{ select: typeof workAllocationFields & { entry: { select: typeof workEntryFields } } }>;
type ReportWorkRow = Prisma.EntryDayAllocationGetPayload<{ select: typeof workAllocationFields & { entry: { select: typeof reportEntryFields } } }>;

type ReportReadLimit = { maxRows: number; acceptRow: (row: ReportWorkRow) => void };

export function readCompletedWork(transaction: Prisma.TransactionClient, scope: WorkScope, entryIds?: string[]): Promise<CompletedWorkRow[]>;
export function readCompletedWork(
	transaction: Prisma.TransactionClient, scope: WorkScope, entryIds: undefined, includeReportFields: true, limit?: ReportReadLimit,
): Promise<ReportWorkRow[]>;
export async function readCompletedWork(transaction: Prisma.TransactionClient, scope: WorkScope, entryIds?: string[], includeReportFields = false, limit?: ReportReadLimit) {
	const rows = [];
	const entryFields = includeReportFields ? reportEntryFields : workEntryFields;
	let scanned = 0;
	for await (const batch of completedWorkBatches(transaction, scope, entryFields, { entryIds })) {
		scanned += batch.length;
		if (limit && scanned > limit.maxRows) {
			throw new ApiRequestError(422, 'REPORT_INPUT_TOO_LARGE', 'Shorten the report period or select a client or project.');
		}
		for (const row of batch) {
			if (!scope.matchesSearch(row.entry)) continue;
			limit?.acceptRow(row as ReportWorkRow);
			rows.push(row);
		}
	}
	return rows;
}

type AllocationReadOptions = { entryIds?: string[]; order?: Prisma.SortOrder };

export async function* completedWorkBatches<T extends Prisma.EntrySelect>(
	transaction: Prisma.TransactionClient, scope: WorkScope, entryFields: T, { entryIds, order = 'asc' }: AllocationReadOptions = {},
): AsyncGenerator<Prisma.EntryDayAllocationGetPayload<{ select: typeof workAllocationFields & { entry: { select: T } } }>[]> {
	if (scope.incompatibleSelection) return;
	let cursor: Prisma.EntryDayAllocationWhereUniqueInput | undefined;
	const batchSize = 256;
	do {
		const batch = await transaction.entryDayAllocation.findMany({
			where: { entryId: entryIds ? { in: entryIds } : undefined, localDate: { gte: scope.range.from, lte: scope.range.to },
				entry: { ...scope.entryWhere, completion: 'complete' } },
			select: { ...workAllocationFields, entry: { select: entryFields } },
			orderBy: [{ localDate: order }, { entryId: order }], take: batchSize, cursor, skip: cursor ? 1 : 0,
		});
		yield batch;
		const last = batch.at(-1);
		cursor = batch.length === batchSize && last
			? { entryId_localDate: { entryId: last.entryId, localDate: last.localDate } }
			: undefined;
	} while (cursor);
}

export async function readIncompleteWork<T extends Prisma.EntryInclude>(
	transaction: Prisma.TransactionClient, scope: WorkScope, include: T, entryIds?: string[],
) {
	if (scope.incompatibleSelection) return [];
	const rows = await transaction.entry.findMany({
		where: {
			...scope.entryWhere, id: entryIds ? { in: entryIds } : undefined, completion: 'incomplete',
			OR: [
				{ durationSeconds: 0, localDate: { gte: scope.range.from, lte: scope.range.to } },
				{ durationSeconds: { gt: 0 }, startAt: { lt: scope.endBefore }, endAt: { gt: scope.startAt } },
			],
		},
		orderBy: [{ localDate: 'desc' }, { startAt: 'desc' }, { id: 'desc' }], include,
	});
	return rows.filter(scope.matchesSearch);
}

export function totalWork(rows: readonly { seconds: number; amountOre: bigint | null }[]) {
	let seconds = 0;
	let amountOre = 0n;
	for (const row of rows) {
		seconds += row.seconds;
		amountOre += row.amountOre ?? 0n;
	}
	if (!Number.isSafeInteger(seconds)) throw new Error('Work duration exceeded the supported total.');
	return { seconds, amountOre };
}
