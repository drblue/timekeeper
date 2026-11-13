import type { WorkListQuery } from '@timekeeper/contracts';

export const datePresets = {
	today: 'Today',
	'this-week': 'This week',
	'this-month': 'This month',
	'previous-month': 'Previous month',
	custom: 'Custom range',
} as const;

export const invoiceChoices = {
	all: 'All invoice statuses',
	invoiced: 'Invoiced',
	'not-yet-invoiced': 'Not yet invoiced',
} as const;

export const billabilityChoices = {
	all: 'All billability',
	billable: 'Billable',
	'non-billable': 'Non-billable',
} as const;

export const workSortChoices = { newest: 'Newest first', oldest: 'Oldest first' } as const;

export type WorkListSearch = Omit<WorkListQuery, 'page' | 'pageSize'> & { page?: number };
export type WorkListLocation = WorkListSearch & {
	returnRow?: string;
	returnOffset?: number;
	returnFrom?: string;
	returnTo?: string;
};

function choice<T extends string>(value: unknown, values: Record<T, string>): T | undefined {
	return typeof value === 'string' && Object.hasOwn(values, value) ? value as T : undefined;
}

function id(value: unknown) {
	return typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value) ? value : undefined;
}

function day(value: unknown) {
	if (typeof value !== 'string' || value.startsWith('0000-') || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
	const date = new Date(value + 'T00:00:00Z');
	return Number.isFinite(date.getTime()) && date.toISOString().startsWith(value) ? value : undefined;
}

function term(value: unknown) {
	if (typeof value !== 'string') return undefined;
	return Array.from(value.trim()).slice(0, 256).join('') || undefined;
}

export function validateWorkListSearch(raw: Record<string, unknown>): WorkListSearch {
	const result: WorkListSearch = {};
	const preset = choice(raw.preset, datePresets);
	const from = day(raw.from);
	const to = day(raw.to);
	const clientId = id(raw.clientId);
	const projectId = id(raw.projectId);
	const invoice = choice(raw.invoice, invoiceChoices);
	const billability = choice(raw.billability, billabilityChoices);
	const description = term(raw.description);
	const invoiceNumber = term(raw.invoiceNumber);
	const sort = choice(raw.sort, workSortChoices);
	const page = Number(raw.page);
	if ((!preset || preset === 'custom') && from && to && from <= to) {
		result.preset = 'custom';
		result.from = from;
		result.to = to;
	} else if (preset && preset !== 'custom' && preset !== 'this-week') {
		result.preset = preset;
	}
	if (clientId) result.clientId = clientId;
	if (projectId) result.projectId = projectId;
	if (invoice && invoice !== 'all') result.invoice = invoice;
	if (billability && billability !== 'all') result.billability = billability;
	if (description) result.description = description;
	if (invoiceNumber) result.invoiceNumber = invoiceNumber;
	if (sort === 'oldest') result.sort = sort;
	if (Number.isSafeInteger(page) && page > 1 && page <= 999_999_999) result.page = page;
	return result;
}

export function validateWorkListLocation(raw: Record<string, unknown>): WorkListLocation {
	const search = validateWorkListSearch(raw);
	const offset = Number(raw.returnOffset);
	const returnFrom = day(raw.returnFrom);
	const returnTo = day(raw.returnTo);
	return {
		...search,
		...(returnFrom && returnTo && returnFrom <= returnTo ? { returnFrom, returnTo } : {}),
		...(typeof raw.returnRow === 'string' && /^[a-f0-9-]{36}:(?:\d{4}-\d{2}-\d{2}|incomplete)$/i.test(raw.returnRow)
			&& Number.isFinite(offset) && Math.abs(offset) <= 10_000 ? { returnRow: raw.returnRow, returnOffset: offset } : {}),
	};
}

export function unpinWorkListSearch(location: WorkListLocation): WorkListSearch {
	const { returnRow, returnOffset, returnFrom, returnTo, ...search } = location;
	return search;
}

export function effectiveWorkListSearch(location: WorkListLocation): WorkListSearch {
	const search = unpinWorkListSearch(location);
	return location.returnFrom && location.returnTo
		? { ...search, preset: 'custom', from: location.returnFrom, to: location.returnTo }
		: search;
}

export function workListQueryString(search: WorkListSearch) {
	const query = new URLSearchParams();
	for (const [name, value] of Object.entries(search)) {
		if (value !== undefined) query.set(name, String(value));
	}
	return query.toString();
}
