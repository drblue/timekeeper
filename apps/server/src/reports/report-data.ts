import { calendarDates, calendarDaysInclusive, maxReportDays } from '@timekeeper/contracts';
import type { ReportPreviewQuery, ReportPreviewResponse } from '@timekeeper/contracts';
import { ApiRequestError } from '../api-error.ts';
import { readCompletedWork, resolveWorkScope, totalWork, workDateRange } from '../entries/work-scope.ts';
import { workAssociation } from '../entries/work-settings.ts';
import type { PrismaClient } from '../generated/prisma/client.ts';
import { validLocalDate } from '../local-date.ts';

type ProjectShare = ReportPreviewResponse['projectShares'][number];
type ReportLine = Omit<ReportPreviewResponse['summaries'][number], 'hourlyRateOre' | 'amountOre'> & {
	hourlyRateOre: bigint | null;
	amountOre: bigint;
};

export interface ReportData {
	readonly showMoney: boolean;
	readonly scope: Readonly<ReportPreviewResponse['scope']>;
	readonly totalSeconds: number;
	readonly totalAmountOre: bigint;
	readonly days: readonly Readonly<ReportPreviewResponse['days'][number]>[];
	readonly projectShares: readonly Readonly<ProjectShare>[];
	readonly summaries: readonly Readonly<ReportLine>[];
	readonly details?: readonly Readonly<ReportLine & { date: string; entryId: string }>[];
	readonly incompatibleSelection: boolean;
}

function compareText(left: string, right: string) {
	return left < right ? -1 : left > right ? 1 : 0;
}

export async function buildReportData(
	database: PrismaClient, accountId: string, query: ReportPreviewQuery, now: Date, includeDetails = false,
): Promise<ReportData> {
	const range = workDateRange(query, now.toISOString());
	if (!validLocalDate(range.from) || !validLocalDate(range.to)) {
		throw new ApiRequestError(422, 'INVALID_DATE_RANGE', 'Enter valid Stockholm calendar dates.');
	}
	const dayCount = calendarDaysInclusive(range.from, range.to);
	if (dayCount > maxReportDays) {
		throw new ApiRequestError(422, 'REPORT_RANGE_TOO_LONG', `Choose a report period of at most ${maxReportDays} days.`);
	}
	const { scope, rows } = await database.$transaction(async (transaction) => {
		const scope = await resolveWorkScope(transaction, accountId, range, query);
		const rows = await readCompletedWork(transaction, scope, undefined, true);
		return { scope, rows };
	});

	const showMoney = query.showMoney === 'true';
	const totals = totalWork(rows);
	const daySeconds = new Map<string, number>();
	const projects = new Map<string | null, ProjectShare>();
	const summaries = new Map<string, ReportLine>();
	const details = includeDetails ? [] as (ReportLine & { date: string; entryId: string })[] : undefined;
	for (const { entry, entryId, localDate, seconds, amountOre } of rows) {
		const { clientId, clientName, projectId, projectName } = workAssociation(entry);
		const description = entry.description.trim();
		const hourlyRateOre = showMoney ? entry.assignedRateOrePerHour : null;
		daySeconds.set(localDate, (daySeconds.get(localDate) ?? 0) + seconds);
		const share = projects.get(projectId);
		if (share) share.seconds += seconds;
		else projects.set(projectId, { projectId, projectName, clientName: projectId ? clientName : null, seconds });

		const summaryKey = JSON.stringify([clientId, projectId, description, hourlyRateOre?.toString() ?? null]);
		const summary = summaries.get(summaryKey);
		if (summary) {
			summary.seconds += seconds;
			summary.amountOre += amountOre;
		} else {
			summaries.set(summaryKey, { clientId, clientName, projectId, projectName, description, seconds, hourlyRateOre, amountOre });
		}
		details?.push({ date: localDate, entryId, clientId, clientName, projectId, projectName, description, seconds, hourlyRateOre, amountOre });
	}
	const projectShares = [...projects.values()].sort((left, right) => right.seconds - left.seconds
		|| compareText(left.projectName ?? '', right.projectName ?? '') || compareText(left.projectId ?? '', right.projectId ?? ''));
	const summaryRows = [...summaries.entries()].sort(([leftKey, left], [rightKey, right]) =>
		compareText(left.clientName ?? '', right.clientName ?? '') || compareText(left.projectName ?? '', right.projectName ?? '')
		|| compareText(left.description, right.description) || compareText(leftKey, rightKey)).map(([, summary]) => Object.freeze(summary));
	details?.sort((left, right) => compareText(left.date, right.date) || compareText(left.entryId, right.entryId));

	return Object.freeze({
		showMoney,
		scope: Object.freeze({ ...range, clientId: query.clientId ?? null, clientName: scope.clientName,
			projectId: query.projectId ?? null, projectName: scope.projectName, invoice: query.invoice ?? 'all', billability: query.billability ?? 'all',
			description: query.description?.trim() ?? '', invoiceNumber: query.invoiceNumber?.trim() ?? '' }),
		totalSeconds: totals.seconds,
		totalAmountOre: totals.amountOre,
		days: Object.freeze(calendarDates(range.from, dayCount).map((date) => Object.freeze({ date, seconds: daySeconds.get(date) ?? 0 }))),
		projectShares: Object.freeze(projectShares.map((share) => Object.freeze(share))),
		summaries: Object.freeze(summaryRows),
		...(details ? { details: Object.freeze(details.map((detail) => Object.freeze(detail))) } : {}),
		incompatibleSelection: scope.incompatibleSelection,
	});
}

export function reportPreview(data: ReportData): ReportPreviewResponse {
	const { showMoney, scope, totalSeconds, totalAmountOre, days, projectShares, summaries, incompatibleSelection } = data;
	return {
		showMoney, scope, totalSeconds, totalAmountOre: totalAmountOre.toString(), days: [...days], projectShares: [...projectShares],
		summaries: summaries.map(({ hourlyRateOre, amountOre, ...row }) => ({ ...row,
			hourlyRateOre: hourlyRateOre?.toString() ?? null, amountOre: amountOre.toString() })),
		incompatibleSelection,
	};
}
