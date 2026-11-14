import { randomUUID } from 'node:crypto';
import { nextStockholmDayStart, stockholmDayStart } from '@timekeeper/contracts';
import type { BulkSplitPortion, WorkListRange } from '@timekeeper/contracts';
import type { Prisma } from '../generated/prisma/client.ts';
import { recordHistory } from './entry-history.ts';
import { activeEntryWhere, entryRelations, entryResponse } from './entry-record.ts';
import type { EntryWithRelations } from './entry-record.ts';
import { requireInvoiceEligibility, writeInvoiceChange } from './invoicing.ts';
import type { InvoiceMetadata } from './invoicing.ts';
import { totalWork } from './work-scope.ts';

type Allocation = EntryWithRelations['allocations'][number];
interface SplitPortion {
	startAt: Date;
	endAt: Date;
	allocations: Allocation[];
	from: string;
	to: string;
	seconds: number;
	amountOre: bigint;
	willInvoice: boolean;
}

export function planEntrySplit(entry: EntryWithRelations, range: WorkListRange): SplitPortion[] {
	if (entry.kind !== 'timed' || !entry.startAt || !entry.endAt || entry.billableAmountOre === null) {
		throw new Error('Invalid timed entry for invoice split');
	}
	const startMillis = entry.startAt.getTime();
	const endMillis = entry.endAt.getTime();
	const batches = [
		entry.allocations.filter(({ localDate }) => localDate < range.from),
		entry.allocations.filter(({ localDate }) => localDate >= range.from && localDate <= range.to),
		entry.allocations.filter(({ localDate }) => localDate > range.to),
	];
	const included = batches[1];
	if (!included?.length) throw new Error('Missing in-range allocation for invoice split');
	const portions = batches.flatMap((allocations, index) => {
		const first = allocations[0];
		const last = allocations.at(-1);
		if (!first || !last) return [];
		const from = first.localDate;
		const to = last.localDate;
		const startAt = new Date(Math.max(startMillis, stockholmDayStart(from)));
		const endAt = new Date(Math.min(endMillis, nextStockholmDayStart(to).epochMilliseconds));
		const { seconds, amountOre } = totalWork(allocations);
		if ((endAt.getTime() - startAt.getTime()) / 1_000 !== seconds) throw new Error('Invalid duration in invoice split allocation');
		return [{ startAt, endAt, allocations, from, to, seconds, amountOre, willInvoice: index === 1 }];
	});
	const { seconds, amountOre } = totalWork(portions);
	if (portions.length < 2 || seconds !== entry.durationSeconds || amountOre !== entry.billableAmountOre
		|| portions[0]?.startAt.getTime() !== startMillis || portions.at(-1)?.endAt.getTime() !== endMillis
		|| portions.some((portion, index) => index > 0 && portions[index - 1]?.endAt.getTime() !== portion.startAt.getTime())) {
		throw new Error('Invoice split did not preserve the original entry');
	}
	return portions;
}

export function splitPreview(portions: SplitPortion[]): { portions: BulkSplitPortion[] } {
	return { portions: portions.map(({ startAt, endAt, from, to, seconds, amountOre, willInvoice }) => ({
		startAt: startAt.toISOString(), endAt: endAt.toISOString(), from, to, seconds, amountOre: amountOre.toString(), willInvoice,
	})) };
}

export async function writeEntrySplit(
	transaction: Prisma.TransactionClient, source: EntryWithRelations, portions: SplitPortion[], metadata: InvoiceMetadata, at: Date, key: string,
) {
	requireInvoiceEligibility(source);
	const { id, accountId, revision, description, projectId, directClientId, billable, assignedRateOrePerHour } = source;
	const original = await transaction.entry.update({
		where: { id, ...activeEntryWhere(accountId), revision, invoicedAt: null },
		data: { supersededAt: at, revision: { increment: 1 } }, include: entryRelations,
	});
	const childEntryIds: string[] = [];
	for (const portion of portions) {
		const child = await transaction.entry.create({
			data: {
				id: randomUUID(), accountId, kind: 'timed', completion: 'complete', description, projectId, directClientId,
				localDate: portion.from, startAt: portion.startAt, endAt: portion.endAt, durationSeconds: portion.seconds,
				billable, assignedRateOrePerHour, billableAmountOre: portion.amountOre, splitFromEntryId: id, createdAt: at,
				allocations: { createMany: { data: portion.allocations.map(({ localDate, seconds, amountOre, calculationVersion }) =>
					({ localDate, seconds, amountOre, calculationVersion })) } },
			},
			include: entryRelations,
		});
		childEntryIds.push(child.id);
		await recordHistory(transaction, 'created-from-split', at, entryResponse(child), undefined, key);
		if (portion.willInvoice) await writeInvoiceChange(transaction, child, { action: 'invoice-marked', metadata }, at, key);
	}
	await recordHistory(transaction, 'split', at, { ...entryResponse(original), splitChildEntryIds: childEntryIds }, entryResponse(source), key);
	return { originalEntryId: id, childEntryIds };
}
