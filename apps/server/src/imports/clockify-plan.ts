import { calendarDaysInclusive, elapsedSeconds, formatStockholmLocalTime, maxEntryDurationSeconds } from '@timekeeper/contracts';
import type {
	ClockifyImportReviewBody, ClockifyImportReviewResponse, ClockifyImportRowDecision, ClockifyPreviewResponse, ClockifyPreviewRow,
	ClockifySource, ClockifyTimestamp,
} from '@timekeeper/contracts';
import { ApiRequestError } from '../api-error.ts';
import { parseHourlyRateOre } from '../billing.ts';
import { entryBilling } from '../entries/entry-record.ts';
import { workDescription } from '../entries/work-settings.ts';
import type { Prisma } from '../generated/prisma/client.ts';
import { validLocalDate } from '../local-date.ts';
import { clockifyCatalogCreations, readClockifyAssociations } from './clockify-association.ts';
import type { ResolvedClockifyAssociation } from './clockify-association.ts';
import { clockifyIdentity, previousClockifyIdentities } from './clockify-identity.ts';

const maxImportAllocations = 8_000;
type Review = Omit<ClockifyImportReviewResponse, 'previewToken' | 'expiresAt'>;
type ReviewRow = Review['rows'][number];

interface SourceTime {
	sourceStartAt: string;
	sourceEndAt: string;
	localDate: string;
	kind: 'timed' | 'duration-only';
	durationSeconds: number;
}

interface SourceRecord {
	line: number;
	source: ClockifySource;
	invoiced: boolean;
	time: SourceTime;
	fingerprint: string;
	candidateKey: string;
}

export interface ClockifyPlannedEntry extends SourceRecord {
	occurrence: number;
	association: ResolvedClockifyAssociation;
	description: string;
	billable: boolean;
	rateOrePerHour: string | null;
	incomplete: boolean;
}

function chosenInstant(timestamp: ClockifyTimestamp | null, occurrence: 'earlier' | 'later' | undefined) {
	if (timestamp?.status === 'valid') return timestamp.candidates[0]?.instant;
	return timestamp?.candidates.find((candidate) => candidate.occurrence === occurrence)?.instant;
}

function sourceRecord(row: ClockifyPreviewRow, decision: ClockifyImportRowDecision | undefined): SourceRecord | string[] {
	if (row.status === 'invalid' || !row.source || row.durationSeconds === null) return ['invalid-source'];
	const sourceStartAt = chosenInstant(row.start, decision?.startOccurrence);
	const sourceEndAt = chosenInstant(row.end, decision?.endOccurrence);
	if (!sourceStartAt || !sourceEndAt) {
		return [...(!sourceStartAt ? ['ambiguous-start'] : []), ...(!sourceEndAt ? ['ambiguous-end'] : [])];
	}
	const elapsed = elapsedSeconds(sourceStartAt, sourceEndAt);
	const localDate = formatStockholmLocalTime(sourceStartAt).local.slice(0, 10);
	if (elapsed <= 0 || elapsed > maxEntryDurationSeconds || !validLocalDate(localDate)
		|| !validLocalDate(formatStockholmLocalTime(sourceEndAt).local.slice(0, 10))) return ['invalid-interval'];
	if (elapsed !== row.durationSeconds && !decision?.durationChoice) return ['duration-mismatch'];
	const kind = decision?.durationChoice === 'duration-only' ? 'duration-only' : 'timed';
	return {
		line: row.line, source: row.source, invoiced: row.invoicedTag === true,
		time: { sourceStartAt, sourceEndAt, localDate, kind, durationSeconds: kind === 'timed' ? elapsed : row.durationSeconds },
		...clockifyIdentity(row.source, sourceStartAt, sourceEndAt, row.durationSeconds),
	};
}

function reviewRow(row: ClockifyPreviewRow, status: ReviewRow['status'], issues: string[] = []): ReviewRow {
	return { line: row.line, status, issues, incomplete: false, invoiced: row.invoicedTag === true, approved: null };
}

function planOccurrences(
	groups: Map<string, { candidateKey: string; lines: number[] }>,
	previous: Awaited<ReturnType<typeof previousClockifyIdentities>>,
	multiplicities: NonNullable<ClockifyImportReviewBody['multiplicities']>,
) {
	const requestedCounts = new Map<string, number>();
	for (const { fingerprint, count } of multiplicities) {
		const group = groups.get(fingerprint);
		if (!group || group.lines.length < 2 || requestedCounts.has(fingerprint) || count > group.lines.length) {
			throw new ApiRequestError(422, 'CLOCKIFY_INVALID_MULTIPLICITY', 'Choose a count within the eligible rows of each current duplicate group.');
		}
		requestedCounts.set(fingerprint, count);
	}

	const duplicateGroups: Review['duplicateGroups'] = [];
	const existingSlots: { fingerprint: string; slots: number[] }[] = [];
	const rowSlots = new Map<number, { occurrence: number; existing: boolean }>();
	for (const [fingerprint, { candidateKey, lines }] of groups) {
		const slots = previous.get(candidateKey)?.get(fingerprint) ?? [];
		const selectedCount = requestedCounts.get(fingerprint) ?? Math.min(lines.length, Math.max(1, slots.length));
		if (lines.length > 1) {
			duplicateGroups.push({ fingerprint, lines, existingCount: slots.length, selectedCount, newCount: Math.max(0, selectedCount - slots.length) });
		}
		if (slots.length) existingSlots.push({ fingerprint, slots });
		const occupied = new Set(slots);
		let vacant = 1;
		for (const [index, line] of lines.slice(0, selectedCount).entries()) {
			const existing = slots[index];
			if (existing !== undefined) {
				rowSlots.set(line, { occurrence: existing, existing: true });
			} else {
				while (occupied.has(vacant)) vacant += 1;
				rowSlots.set(line, { occurrence: vacant, existing: false });
				vacant += 1;
			}
		}
	}
	return { duplicateGroups, existingSlots, rowSlots };
}

export async function planClockifyImport(
	transaction: Prisma.TransactionClient, accountId: string, inspection: ClockifyPreviewResponse, input: ClockifyImportReviewBody,
) {
	const lineSet = new Set(inspection.rows.map(({ line }) => line));
	const decisions = new Map<number, ClockifyImportRowDecision>();
	for (const decision of input.rows) {
		if (!lineSet.has(decision.line) || decisions.has(decision.line)) {
			throw new ApiRequestError(422, 'CLOCKIFY_INVALID_DECISIONS', 'Choose each inspected row at most once.');
		}
		decisions.set(decision.line, decision);
	}

	const analyzed = inspection.rows.map((row) => {
		const decision = decisions.get(row.line);
		return { row, decision, record: sourceRecord(row, decision) };
	});
	const previous = await previousClockifyIdentities(transaction, accountId, analyzed.flatMap(({ record }) =>
		Array.isArray(record) ? [] : [record.candidateKey]));
	const candidates = new Map<string, Set<string>>();
	const groups = new Map<string, { candidateKey: string; lines: number[] }>();
	for (const { record, decision } of analyzed) {
		if (Array.isArray(record) || decision?.exclude) continue;
		const group = groups.get(record.fingerprint);
		if (group) group.lines.push(record.line);
		else groups.set(record.fingerprint, { candidateKey: record.candidateKey, lines: [record.line] });
		let fingerprints = candidates.get(record.candidateKey);
		if (!fingerprints) {
			fingerprints = new Set();
			candidates.set(record.candidateKey, fingerprints);
		}
		fingerprints.add(record.fingerprint);
	}

	const { duplicateGroups, existingSlots, rowSlots } = planOccurrences(groups, previous, input.multiplicities ?? []);
	const resolveAssociation = await readClockifyAssociations(transaction, accountId);
	const entries: ClockifyPlannedEntry[] = [];
	let allocations = 0;
	const rows = analyzed.map(({ row, decision, record }): ReviewRow => {
		if (decision?.exclude) return reviewRow(row, 'excluded');
		if (Array.isArray(record)) return reviewRow(row, 'blocked', record);
		const slot = rowSlots.get(record.line);
		if (!slot) return reviewRow(row, 'duplicate-omitted');
		if (slot.existing) return reviewRow(row, 'already-imported');
		const prior = previous.get(record.candidateKey);
		const exactPriorCount = prior?.has(record.fingerprint) ? 1 : 0;
		if ((prior?.size ?? 0) > exactPriorCount || (candidates.get(record.candidateKey)?.size ?? 0) > 1) {
			return reviewRow(row, 'blocked', ['possible-correction']);
		}

		const issues: string[] = [];
		const association = resolveAssociation(decision?.association ?? input.defaults?.association, record.source);
		if (typeof association === 'string') issues.push(association);
		const billing = decision?.billing ?? input.defaults?.billing;
		let rate: bigint | null = null;
		const billable = billing?.mode === 'billable';
		if (!billing) issues.push('missing-billing');
		if (billing?.mode === 'billable') {
			try {
				rate = parseHourlyRateOre(billing.rateOrePerHour, 'rateOrePerHour');
			} catch (error) {
				if (!(error instanceof ApiRequestError)) throw error;
				issues.push('invalid-rate');
			}
		}
		if (billing?.mode === 'non-billable' && record.invoiced) issues.push('invoiced-non-billable');
		let description = '';
		try {
			description = workDescription(record.source.description, true);
		} catch (error) {
			if (!(error instanceof ApiRequestError)) throw error;
			issues.push('description-too-long');
		}
		const { kind, durationSeconds, localDate, sourceStartAt, sourceEndAt } = record.time;
		const calculated = entryBilling({ description, projectId: null, directClientId: null, billable, assignedRateOrePerHour: rate }, durationSeconds);
		if (calculated.missingFields.includes('amount')) issues.push('amount-out-of-range');
		const incomplete = calculated.missingFields.some((field) => field === 'description' || field === 'rate');
		if (incomplete && kind === 'duration-only') issues.push('duration-only-incomplete');
		if (incomplete && !decision?.acceptIncomplete) issues.push('incomplete-not-approved');
		if (issues.length || typeof association === 'string') return { ...reviewRow(row, 'blocked', issues), incomplete };

		if (!incomplete) {
			const endDate = kind === 'timed' ? formatStockholmLocalTime(new Date(Date.parse(sourceEndAt) - 1_000).toISOString()).local.slice(0, 10) : localDate;
			allocations += calendarDaysInclusive(localDate, endDate);
		}
		if (allocations > maxImportAllocations) {
			throw new ApiRequestError(422, 'CLOCKIFY_IMPORT_TOO_LARGE', 'Review a smaller selection. An import can create up to 8000 day allocations.');
		}
		const rateOrePerHour = rate?.toString() ?? null;
		entries.push({ ...record, occurrence: slot.occurrence, association, description, billable, rateOrePerHour, incomplete });
		return {
			...reviewRow(row, 'new'),
			incomplete,
			approved: {
				clientId: association.client?.mode === 'existing' ? association.client.id : null,
				projectId: association.project?.mode === 'existing' ? association.project.id : null,
				clientName: association.client?.name ?? null, projectName: association.project?.name ?? null,
				billable, rateOrePerHour, kind, localDate, durationSeconds,
				startAt: kind === 'timed' ? sourceStartAt : null, endAt: kind === 'timed' ? sourceEndAt : null,
				amountOre: calculated.billableAmountOre?.toString() ?? null,
			},
		};
	});
	const creations = clockifyCatalogCreations(entries.map(({ association }) => association));
	if (creations.conflictingNames) {
		throw new ApiRequestError(422, 'CLOCKIFY_INVALID_DECISIONS', 'Use one consistent spelling for each new client and project name.');
	}
	const counts = { new: 0, alreadyImported: 0, excluded: 0, duplicateOmitted: 0, blocked: 0, incomplete: 0, invoiced: 0 };
	for (const row of rows) {
		if (row.status === 'already-imported') counts.alreadyImported += 1;
		else if (row.status === 'duplicate-omitted') counts.duplicateOmitted += 1;
		else counts[row.status] += 1;
		if (row.status === 'new' && row.incomplete) counts.incomplete += 1;
		if (row.status === 'new' && row.invoiced) counts.invoiced += 1;
	}
	return { entries, existingSlots, review: {
		canCommit: counts.blocked === 0 && (counts.new > 0 || counts.alreadyImported > 0), counts, rows, duplicateGroups,
		createClients: creations.clients, createProjects: creations.projects,
	} };
}
