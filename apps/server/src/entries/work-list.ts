import { defaultWorkListPageSize, maxWorkListPageSize } from '@timekeeper/contracts';
import type { WorkListQuery, WorkListResponse } from '@timekeeper/contracts';
import { ApiRequestError } from '../api-error.ts';
import type { PrismaClient } from '../generated/prisma/client.ts';
import { activeEntryWhere, entryRelations, entryResponse } from './entry-record.ts';
import { readCompletedWork, readIncompleteWork, resolveWorkScope, totalWork, workDateRange } from './work-scope.ts';

function compareText(left: string, right: string) {
	return left < right ? -1 : left > right ? 1 : 0;
}

export function createWorkList(database: PrismaClient, now: () => Date = () => new Date()) {
	return async function getWorkList(accountId: string, query: WorkListQuery): Promise<WorkListResponse> {
		const range = workDateRange(query, now().toISOString());
		const pageSize = Number(query.pageSize ?? defaultWorkListPageSize);
		if (pageSize > maxWorkListPageSize) throw new ApiRequestError(422, 'INVALID_PAGE_SIZE', `Choose at most ${maxWorkListPageSize} rows per page.`);
		const requestedPage = Number(query.page ?? 1);
		const direction = query.sort === 'oldest' ? 1 : -1;

		return database.$transaction(async (transaction) => {
			const scope = await resolveWorkScope(transaction, accountId, range, query);
			const rows = await readCompletedWork(transaction, scope);
			const totals = totalWork(rows);
			const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
			const page = Math.min(requestedPage, totalPages);
			rows.sort((left, right) => direction * (
				compareText(left.localDate, right.localDate)
				|| (left.entry.startAt ?? left.entry.createdAt).getTime() - (right.entry.startAt ?? right.entry.createdAt).getTime()
				|| compareText(left.entryId, right.entryId)
			));
			const pageRows = rows.slice((page - 1) * pageSize, page * pageSize);
			const ids = [...new Set(pageRows.map(({ entryId }) => entryId))];
			const pageEntries = ids.length ? await transaction.entry.findMany({ where: { ...activeEntryWhere(accountId), id: { in: ids } }, include: entryRelations }) : [];
			const entries = new Map(pageEntries.map((entry) => [entry.id, entryResponse(entry)]));
			const groups: WorkListResponse['groups'] = [];
			for (const row of pageRows) {
				const entry = entries.get(row.entryId);
				if (!entry || entry.completion !== 'complete') throw new Error('Completed allocation did not have a completed entry.');
				let group = groups.at(-1);
				if (!group || group.localDate !== row.localDate) {
					group = { localDate: row.localDate, rows: [] };
					groups.push(group);
				}
				group.rows.push({ entry, seconds: row.seconds, amountOre: row.amountOre.toString() });
			}
			const incompleteRows = await readIncompleteWork(transaction, scope, entryRelations);
			const incomplete = incompleteRows.map((entry) => {
				const response = entryResponse(entry);
				if (response.completion !== 'incomplete') throw new Error('Incomplete work did not have an incomplete entry.');
				return response;
			});
			return {
				range, page, pageSize, totalRows: rows.length, totalPages, groups, incomplete,
				totals: { seconds: totals.seconds, amountOre: totals.amountOre.toString() },
				incompatibleSelection: scope.incompatibleSelection,
			};
		});
	};
}
