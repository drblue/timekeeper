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

export async function planClockifyImport(
	transaction: Prisma.TransactionClient, accountId: string, inspection: ClockifyPreviewResponse, input: ClockifyImportReviewBody,
): Promise<{ review: Review; entries: ClockifyPlannedEntry[] }> {
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
	const occurrences = new Map<string, number>();
	for (const { record, decision } of analyzed) {
		if (Array.isArray(record) || decision?.exclude) continue;
		occurrences.set(record.fingerprint, (occurrences.get(record.fingerprint) ?? 0) + 1);
		let fingerprints = candidates.get(record.candidateKey);
		if (!fingerprints) {
			fingerprints = new Set();
			candidates.set(record.candidateKey, fingerprints);
		}
		fingerprints.add(record.fingerprint);
	}

	const resolveAssociation = await readClockifyAssociations(transaction, accountId);
	const entries: ClockifyPlannedEntry[] = [];
	let allocations = 0;
	const rows = analyzed.map(({ row, decision, record }): ReviewRow => {
		if (decision?.exclude) return reviewRow(row, 'excluded');
		if (Array.isArray(record)) return reviewRow(row, 'blocked', record);
		if ((occurrences.get(record.fingerprint) ?? 0) > 1) return reviewRow(row, 'blocked', ['duplicate-source']);
		const prior = previous.get(record.candidateKey);
		if (prior?.has(record.fingerprint)) return reviewRow(row, 'already-imported');
		if (prior?.size || (candidates.get(record.candidateKey)?.size ?? 0) > 1) {
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
		entries.push({ ...record, association, description, billable, rateOrePerHour, incomplete });
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
	const counts = { new: 0, alreadyImported: 0, excluded: 0, blocked: 0, incomplete: 0, invoiced: 0 };
	for (const row of rows) {
		if (row.status === 'already-imported') counts.alreadyImported += 1;
		else counts[row.status] += 1;
		if (row.status === 'new' && row.incomplete) counts.incomplete += 1;
		if (row.status === 'new' && row.invoiced) counts.invoiced += 1;
	}
	return { entries, review: {
		canCommit: counts.blocked === 0 && (counts.new > 0 || counts.alreadyImported > 0), counts, rows,
		createClients: creations.clients, createProjects: creations.projects,
	} };
}
