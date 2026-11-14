import type { EntriesCsvExportQuery, WorkListRange } from '@timekeeper/contracts';
import type { Prisma } from '../generated/prisma/client.ts';
import { compareWorkRows, completedWorkBatches, resolveWorkScope } from '../entries/work-scope.ts';
import { exportTooLarge } from './spool.ts';
import { workAssociation, workRelations } from '../entries/work-settings.ts';

const maxDayCsvRows = 25_000;
const maxDayCsvBytes = 32 * 1024 * 1024;

const header = [
	'Datum', 'Tidpost-ID', 'Typ', 'Kund', 'Projekt', 'Beskrivning', 'Start (UTC)', 'Slut (UTC)',
	'Sekunder', 'Tid (hh:mm:ss)', 'Debiterbar', 'Timpris (SEK)', 'Timpris (öre)', 'Belopp (SEK)', 'Belopp (öre)',
	'Fakturerad', 'Fakturanummer', 'Fakturadatum', 'Fakturareferens',
];

const csvFields = {
	...workRelations,
	projectId: true, directClientId: true, description: true, kind: true, startAt: true, endAt: true, createdAt: true,
	billable: true, assignedRateOrePerHour: true, invoicedAt: true, invoiceNumber: true, invoiceDate: true, invoiceReference: true,
} as const;

function quote(value: string) {
	return /[;"\r\n]/.test(value) ? '"' + value.replaceAll('"', '""') + '"' : value;
}

function userText(input: string | null, asText = false) {
	if (!input) return '';
	// Check the original leading characters before replacing control characters.
	const unsafe = /^[\t\r\n]/.test(input) || /^[\s\p{Cc}\p{Cf}]*[=+\-@\uFF1D\uFF0B\uFF0D\uFF20]/u.test(input);
	const value = input.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '\uFFFD');
	return asText || unsafe ? "'" + value : value;
}

function sek(ore: bigint | null) {
	if (ore === null) return '';
	const absolute = ore < 0n ? -ore : ore;
	return (ore < 0n ? '-' : '') + (absolute / 100n).toString() + ',' + (absolute % 100n).toString().padStart(2, '0');
}

function elapsed(seconds: number) {
	const hours = String(Math.floor(seconds / 3_600)).padStart(2, '0');
	const minutes = String(Math.floor(seconds / 60) % 60).padStart(2, '0');
	return [hours, minutes, String(seconds % 60).padStart(2, '0')].join(':');
}

export async function* entriesCsv(
	transaction: Prisma.TransactionClient, accountId: string, range: WorkListRange, query: EntriesCsvExportQuery,
) {
	const scope = await resolveWorkScope(transaction, accountId, range, query);
	yield '\uFEFF' + header.join(';') + '\r\n';
	const direction = query.sort === 'oldest' ? 1 : -1;
	const order = direction === 1 ? 'asc' : 'desc';
	let groupDate: string | undefined;
	let group: { localDate: string; entryId: string; entry: { startAt: Date | null; createdAt: Date }; line: string }[] = [];
	let groupBytes = 0;
	for await (const rows of completedWorkBatches(transaction, scope, csvFields, { order })) {
		for (const row of rows) {
			const { entry, localDate, seconds, amountOre } = row;
			if (!scope.matchesSearch(entry)) continue;
			if (groupDate !== undefined && groupDate !== localDate) {
				group.sort((left, right) => direction * compareWorkRows(left, right));
				for (const { line } of group) yield line;
				group = [];
				groupBytes = 0;
			}
			groupDate = localDate;
			const { clientName, projectName } = workAssociation(entry);
			const hourlyRate = entry.assignedRateOrePerHour;
			const line = [
				localDate, row.entryId, entry.kind === 'timed' ? 'Med start och slut' : 'Endast varaktighet',
				userText(clientName), userText(projectName), userText(entry.description),
				entry.startAt?.toISOString() ?? '', entry.endAt?.toISOString() ?? '',
				String(seconds), elapsed(seconds), entry.billable ? 'Ja' : 'Nej', sek(hourlyRate), hourlyRate?.toString() ?? '',
				sek(amountOre), amountOre.toString(), entry.invoicedAt ? 'Ja' : 'Nej',
				userText(entry.invoiceNumber, true), entry.invoiceDate ?? '', userText(entry.invoiceReference),
			].map(quote).join(';') + '\r\n';
			groupBytes += Buffer.byteLength(line);
			if (group.length >= maxDayCsvRows || groupBytes > maxDayCsvBytes) exportTooLarge();
			group.push({ localDate, entryId: row.entryId, entry: { startAt: entry.startAt, createdAt: entry.createdAt }, line });
		}
	}
	group.sort((left, right) => direction * compareWorkRows(left, right));
	for (const { line } of group) yield line;
}
