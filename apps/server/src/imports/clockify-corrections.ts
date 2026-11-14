import { Value } from '@sinclair/typebox/value';
import { ClockifySource } from '@timekeeper/contracts';
import type { ClockifyCorrectionCandidate, ClockifyCorrectionProposal, ClockifyCorrectionTargetsQuery, EntryResponse } from '@timekeeper/contracts';
import { ApiRequestError } from '../api-error.ts';
import { entryRelations, entryResponse } from '../entries/entry-record.ts';
import type { EntryWithRelations } from '../entries/entry-record.ts';
import { workAssociation, workRelations } from '../entries/work-settings.ts';
import { prepareEdit } from '../entries/store.ts';
import type { EntryTime } from '../entries/store.ts';
import type { Prisma } from '../generated/prisma/client.ts';
import { sourceDuration } from './clockify-preview.ts';

const identityFields = { fingerprint: true, occurrence: true, entryId: true, sourceSnapshot: true } as const;
const clockifyCorrectionTargetFields = { ...identityFields, entry: { include: workRelations } } as const;
export type CorrectionTarget = Prisma.ClockifyImportIdentityGetPayload<{ select: typeof clockifyCorrectionTargetFields }>;

function snapshotSource(sourceSnapshot: string) {
	const parsed: unknown = JSON.parse(sourceSnapshot);
	if (!parsed || typeof parsed !== 'object' || !('version' in parsed) || parsed.version !== 1
		|| !('source' in parsed) || !Value.Check(ClockifySource, parsed.source)
		|| !('sourceStartAt' in parsed) || typeof parsed.sourceStartAt !== 'string'
		|| !('sourceEndAt' in parsed) || typeof parsed.sourceEndAt !== 'string') throw new Error('Invalid Clockify identity source');
	return { source: parsed.source, sourceStartAt: parsed.sourceStartAt, sourceEndAt: parsed.sourceEndAt };
}

export function correctionCandidate(target: CorrectionTarget, sourceSnapshot = target.sourceSnapshot): ClockifyCorrectionCandidate {
	const { entry } = target;
	const { clientName, projectName } = workAssociation(entry);
	return {
		entryId: entry.id, revision: entry.revision,
		state: entry.deletedAt ? 'deleted' : entry.supersededAt || entry.splitFromEntryId ? 'split' : entry.invoicedAt ? 'invoiced' : entry.completion === 'incomplete' ? 'incomplete' : 'active',
		source: snapshotSource(sourceSnapshot).source,
		description: entry.description, localDate: entry.localDate, durationSeconds: entry.durationSeconds,
		startAt: entry.startAt?.toISOString() ?? null, endAt: entry.endAt?.toISOString() ?? null,
		billable: entry.billable, rateOrePerHour: entry.assignedRateOrePerHour?.toString() ?? null, amountOre: entry.billableAmountOre?.toString() ?? null,
		clientName, projectName, invoicedAt: entry.invoicedAt?.toISOString() ?? null,
	};
}

export function correctionSnapshot(entry: EntryWithRelations) {
	return {
		entry: entryResponse(entry),
		allocations: entry.allocations.map(({ amountOre, ...allocation }) => ({ ...allocation, amountOre: amountOre.toString() })),
	};
}

export function correctionFields(sourceSnapshot: string, source: ClockifySource, time: { sourceStartAt: string; sourceEndAt: string }) {
	const before = snapshotSource(sourceSnapshot);
	const normalizeLineBreaks = (text: string) => text.replace(/\r\n?/g, '\n');
	return {
		descriptionChanged: normalizeLineBreaks(before.source.description) !== normalizeLineBreaks(source.description),
		timeChanged: before.sourceStartAt !== time.sourceStartAt || before.sourceEndAt !== time.sourceEndAt
			|| sourceDuration(before.source.durationH) !== sourceDuration(source.durationH),
	};
}

export async function relevantCorrectionSource(
	transaction: Prisma.TransactionClient, accountId: string, target: CorrectionTarget,
	incomingFingerprint: string,
) {
	// Compare to the latest approved source for this target, including
	// metadata-only keep decisions. A later local edit is not a source change.
	const latest = await transaction.clockifyImportAlias.findFirst({
		where: { accountId, targetFingerprint: target.fingerprint, targetOccurrence: target.occurrence,
			fingerprint: { not: incomingFingerprint } },
		select: { sourceSnapshot: true },
		orderBy: [{ batch: { committedAt: 'desc' } }, { fingerprint: 'asc' }, { occurrence: 'asc' }],
	});
	return latest?.sourceSnapshot ?? target.sourceSnapshot;
}

export async function prepareClockifyCorrection(
	transaction: Prisma.TransactionClient, accountId: string, entry: EntryWithRelations,
	description: string, proposedTime: EntryTime | undefined, kind: EntryResponse['kind'] | undefined,
) {
	const edit = await prepareEdit(transaction, accountId, entry, {
		revision: entry.revision, description, projectId: entry.projectId, directClientId: entry.directClientId, billable: entry.billable,
	}, proposedTime, kind);
	const proposal: ClockifyCorrectionProposal = {
		description: edit.work.description,
		localDate: edit.time?.localDate ?? entry.localDate,
		startAt: edit.time ? edit.time.startAt?.toISOString() ?? null : entry.startAt?.toISOString() ?? null,
		endAt: edit.time ? edit.time.endAt?.toISOString() ?? null : entry.endAt?.toISOString() ?? null,
		durationSeconds: edit.time?.durationSeconds ?? entry.durationSeconds,
		amountOre: edit.billableAmountOre.toString(),
		overlap: edit.overlap,
	};
	return { edit, proposal };
}

export function loadClockifyCorrectionEntry(transaction: Prisma.TransactionClient, accountId: string, id: string) {
	return transaction.entry.findUniqueOrThrow({ where: { id, accountId }, include: entryRelations });
}

export function countClockifyCorrectionAllocations(transaction: Prisma.TransactionClient, accountId: string, entryId: string) {
	return transaction.entryDayAllocation.count({ where: { entryId, entry: { accountId } } });
}

export async function clockifyTargetsByEntryIds(transaction: Prisma.TransactionClient, accountId: string, entryIds: string[]) {
	const keys = [...new Set(entryIds)];
	const result = new Map<string, CorrectionTarget>();
	for (let start = 0; start < keys.length; start += 128) {
		const roots = await transaction.clockifyImportIdentity.findMany({
			where: { accountId, entryId: { in: keys.slice(start, start + 128) } },
			select: clockifyCorrectionTargetFields, orderBy: [{ fingerprint: 'asc' }, { occurrence: 'asc' }],
		});
		for (const root of roots) if (!result.has(root.entryId)) result.set(root.entryId, root);
	}
	return result;
}

export async function searchClockifyCorrectionTargets(transaction: Prisma.TransactionClient, accountId: string, query: ClockifyCorrectionTargetsQuery) {
	const search = query.search?.trim();
	if (query.cursor && !await transaction.entry.findUnique({
		where: { id: query.cursor, accountId, clockifyImportIdentities: { some: { accountId } } }, select: { id: true },
	})) {
		throw new ApiRequestError(422, 'CLOCKIFY_INVALID_CURSOR', 'Restart the correction target search.');
	}
	// Scan a fixed number of owner-scoped roots with keyset pagination. Literal
	// matching uses the same Unicode rules regardless of database provider.
	const maxScanned = 64;
	const matches = await transaction.entry.findMany({
		where: { accountId, id: query.cursor ? { gt: query.cursor } : undefined, clockifyImportIdentities: { some: { accountId } } },
		select: { id: true, description: true, localDate: true, clockifyImportIdentities: {
			where: { accountId }, select: { sourceSnapshot: true }, orderBy: [{ fingerprint: 'asc' }, { occurrence: 'asc' }],
		} },
		orderBy: { id: 'asc' }, take: maxScanned,
	});
	const normalize = (value: string) => value.normalize('NFC').toLowerCase();
	const queryText = normalize(search ?? '');
	const page: string[] = [];
	let scanned = 0;
	let last: string | null = null;
	for (const { id, description, localDate, clockifyImportIdentities } of matches) {
		scanned += 1;
		last = id;
		const source = clockifyImportIdentities[0];
		if (queryText && ![id, description, localDate, ...Object.values(source ? snapshotSource(source.sourceSnapshot).source : {})]
			.some((value) => normalize(value).includes(queryText))) continue;
		page.push(id);
		if (page.length === 20) break;
	}
	const targets = await clockifyTargetsByEntryIds(transaction, accountId, page);
	return {
		candidates: page.map((id) => correctionCandidate(targets.get(id)!)),
		nextCursor: scanned < matches.length || matches.length === maxScanned ? last : null,
	};
}
