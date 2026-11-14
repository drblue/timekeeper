import { effectiveWorkListSearch, validateWorkListLocation, validateWorkListSearch, workListQueryString } from './work-list-search';
import type { WorkListLocation, WorkListSearch } from './work-list-search';

export type ReportSearch = Omit<WorkListSearch, 'page' | 'sort'> & {
	showMoney?: 'true';
	language?: 'sv';
	includeDetails?: 'true';
	back?: string;
};

export function reportFilters(search: WorkListSearch) {
	const { page: _page, sort: _sort, ...filters } = search;
	return filters;
}

export function reportFromWorkList(location: WorkListLocation, range?: { from: string; to: string }): ReportSearch {
	const filters = reportFilters(effectiveWorkListSearch(location));
	const { returnRow: _row, returnOffset: _offset, ...backLocation } = location;
	const back = workListQueryString({ ...backLocation, ...(range ? { returnFrom: range.from, returnTo: range.to } : {}) });
	return {
		...filters,
		...(range ? { preset: 'custom', ...range } : {}),
		back: back || undefined,
	};
}

export function validateReportSearch(raw: Record<string, unknown>): ReportSearch {
	const back = typeof raw.back === 'string'
		? workListQueryString(reportBackSearch(raw.back)) : undefined;
	return {
		...reportFilters(validateWorkListSearch(raw)),
		showMoney: raw.showMoney === 'true' ? 'true' : undefined,
		language: raw.language === 'sv' ? 'sv' : undefined,
		includeDetails: raw.includeDetails === 'true' ? 'true' : undefined,
		back: back || undefined,
	};
}

export function reportBackSearch(back?: string): WorkListLocation {
	return validateWorkListLocation(Object.fromEntries(new URLSearchParams(back)));
}
