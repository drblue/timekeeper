import { calendarDaysInclusive, elapsedSeconds, formatStockholmLocalTime, maxEntryDurationSeconds } from '@timekeeper/contracts';
import type {
	ClockifyImportReviewBody, ClockifyImportReviewResponse, ClockifyImportRowDecision, ClockifyPreviewResponse, ClockifyPreviewRow,
	ClockifySource, ClockifyTimestamp,
} from '@timekeeper/contracts';
import { ApiRequestError } from '../api-error.ts';
import { parseHourlyRateOre } from '../billing.ts';
import { timedInterval } from '../entries/timed-entry.ts';
import { entryBilling } from '../entries/entry-record.ts';
import { workDescription } from '../entries/work-settings.ts';
import type { Prisma } from '../generated/prisma/client.ts';
import { validLocalDate } from '../local-date.ts';
import { clockifyCatalogCreations, readClockifyAssociations } from './clockify-association.ts';
import type { ResolvedClockifyAssociation } from './clockify-association.ts';
import { clockifyTargetsByEntryIds, correctionCandidate, correctionFields, correctionSnapshot, countClockifyCorrectionAllocations, loadClockifyCorrectionEntry, prepareClockifyCorrection, relevantCorrectionSource } from './clockify-corrections.ts';
import type { ClockifyClaim } from './clockify-identity.ts';
import { clockifyIdentity, previousClockifyIdentities } from './clockify-identity.ts';

const maxImportAllocations = 8_000;
const maxCorrectionRows = 100;
const maxCorrectionDetailsBytes = 8 * 1024 * 1024;
const maxCorrectionSavedAllocations = 8_000;
type Review = Omit<ClockifyImportReviewResponse, 'previewToken' | 'expiresAt'>;
type ReviewRow = Review['rows'][number];
type CorrectionReview = NonNullable<ReviewRow['correction']>;

export interface ClockifyPlannedCorrection extends SourceRecord {
	occurrence: number;
	resolution: 'keep' | 'update';
	target: {
		entryId: string;
		revision: number;
		fingerprint: string;
		occurrence: number;
	};
	update: { description: string; changeTime: boolean; before: ReturnType<typeof correctionSnapshot> } | null;
}

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

function clockifyAllocationDays({ kind, localDate, sourceEndAt }: SourceTime) {
	if (kind === 'duration-only') return 1;
	const endDate = formatStockholmLocalTime(new Date(Date.parse(sourceEndAt) - 1_000).toISOString()).local.slice(0, 10);
	return calendarDaysInclusive(localDate, endDate);
}

export function clockifyEntryTime({ kind, localDate, durationSeconds, sourceStartAt, sourceEndAt }: SourceTime, incomplete = false) {
	const startAt = kind === 'timed' ? new Date(sourceStartAt) : null;
	const endAt = kind === 'timed' ? new Date(sourceEndAt) : null;
	return startAt && endAt && !incomplete
		? timedInterval(startAt, endAt)
		: { localDate, durationSeconds, startAt, endAt, segments: [{ localDate, seconds: durationSeconds }] };
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
	return { line: row.line, status, issues, incomplete: false, invoiced: row.invoicedTag === true, correction: null, approved: null };
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
	const existingSlots: { fingerprint: string; claims: ClockifyClaim[] }[] = [];
	const rowSlots = new Map<number, { occurrence: number; existing: boolean }>();
	for (const [fingerprint, { candidateKey, lines }] of groups) {
		const claims = previous.get(candidateKey)?.get(fingerprint) ?? [];
		const slots = claims.map(({ occurrence }) => occurrence);
		const selectedCount = requestedCounts.get(fingerprint) ?? Math.min(lines.length, Math.max(1, slots.length));
		if (lines.length > 1) {
			duplicateGroups.push({ fingerprint, lines, existingCount: slots.length, selectedCount, newCount: Math.max(0, selectedCount - slots.length) });
		}
		if (slots.length) existingSlots.push({ fingerprint, claims });
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
	const selectedTargetIds = analyzed.flatMap(({ decision, row, record }) => {
		const choice = decision?.correction;
		const slot = rowSlots.get(row.line);
		return !decision?.exclude && !Array.isArray(record) && slot && !slot.existing && choice && choice.mode !== 'separate'
			? [choice.entryId] : [];
	});
	const weakTargetIds = new Map<string, string[]>();
	for (const { record, decision, row } of analyzed) {
		const slot = rowSlots.get(row.line);
		if (Array.isArray(record) || decision?.exclude || !slot || slot.existing || weakTargetIds.has(record.candidateKey)) continue;
		const prior = previous.get(record.candidateKey);
		if (!prior) continue;
		const ids = [...new Set([...prior.values()].flatMap((claims) => claims.map(({ entryId }) => entryId)))].sort();
		weakTargetIds.set(record.candidateKey, ids);
	}
	const comparedRows = analyzed.filter(({ row, record, decision }) => {
		const slot = rowSlots.get(row.line);
		return !Array.isArray(record) && slot && !slot.existing
			&& (decision?.correction || (previous.get(record.candidateKey)?.size ?? 0) > (previous.get(record.candidateKey)?.has(record.fingerprint) ? 1 : 0)
				|| (candidates.get(record.candidateKey)?.size ?? 0) > 1);
	}).length;
	if (comparedRows > maxCorrectionRows) {
		throw new ApiRequestError(422, 'CLOCKIFY_IMPORT_TOO_LARGE', 'Review up to 100 correction rows in one import.');
	}
	const targets = await clockifyTargetsByEntryIds(transaction, accountId,
		[...selectedTargetIds, ...[...weakTargetIds.values()].flatMap((ids) => ids.slice(0, 5))]);
	const resolveAssociation = await readClockifyAssociations(transaction, accountId);
	const corrections: ClockifyPlannedCorrection[] = [];
	const correctedTargets = new Set<string>();
	const entries: ClockifyPlannedEntry[] = [];
	let allocations = 0;
	let savedAllocations = 0;
	const rows: ReviewRow[] = [];
	function reserveAllocations(days: number) {
		allocations += days;
		if (allocations > maxImportAllocations) {
			throw new ApiRequestError(422, 'CLOCKIFY_IMPORT_TOO_LARGE', 'Review a smaller selection. An import can create up to 8000 day allocations.');
		}
	}
	let correctionBytes = 0;
	for (const { row, decision, record } of analyzed) {
		const planned = await planRow(row, decision, record);
		if (planned.correction) {
			correctionBytes += Buffer.byteLength(JSON.stringify(planned.correction));
			if (correctionBytes > maxCorrectionDetailsBytes) {
				throw new ApiRequestError(422, 'CLOCKIFY_IMPORT_TOO_LARGE', 'Review a smaller selection of correction details.');
			}
		}
		rows.push(planned);
	}

	async function planRow(row: ClockifyPreviewRow, decision: ClockifyImportRowDecision | undefined, record: SourceRecord | string[]): Promise<ReviewRow> {
		if (decision?.exclude) return reviewRow(row, 'excluded');
		if (Array.isArray(record)) return reviewRow(row, 'blocked', record);
		const slot = rowSlots.get(record.line);
		if (!slot) return reviewRow(row, 'duplicate-omitted');
		if (slot.existing) return reviewRow(row, 'already-imported');
		const prior = previous.get(record.candidateKey);
		const exactClaims = prior?.get(record.fingerprint) ?? [];
		const exactPriorCount = exactClaims.length > 0 ? 1 : 0;
		const possibleCorrection = (prior?.size ?? 0) > exactPriorCount || (candidates.get(record.candidateKey)?.size ?? 0) > 1;
		const choice = decision?.correction;
		if (possibleCorrection || (choice && choice.mode !== 'separate')) {
			const weakIds = weakTargetIds.get(record.candidateKey) ?? [];
			const correction: CorrectionReview = {
				candidateCount: weakIds.length, candidates: weakIds.slice(0, 5).flatMap((id) => {
					const target = targets.get(id);
					return target ? [correctionCandidate(target)] : [];
				}),
				selected: null, proposed: null,
			};
			if (!choice) return { ...reviewRow(row, 'blocked', ['possible-correction']), correction };
			if (choice.mode !== 'separate') {
				const target = targets.get(choice.entryId);
				if (!target) return { ...reviewRow(row, 'blocked', ['correction-target-changed']), correction };
				const baseline = await relevantCorrectionSource(transaction, accountId, target, record.fingerprint);
				correction.selected = correctionCandidate(target, baseline);
				if (target.entry.revision !== choice.revision) {
					return { ...reviewRow(row, 'blocked', ['correction-target-changed']), correction };
				}
				if (exactClaims.some(({ entryId }) => entryId === target.entryId) || correctedTargets.has(target.entryId)) {
					return { ...reviewRow(row, 'blocked', ['correction-target-reused']), correction };
				}
				if (choice.mode === 'update' && (correction.selected.state !== 'active')) {
					return { ...reviewRow(row, 'blocked', ['correction-target-locked']), correction };
				}
				let update: ClockifyPlannedCorrection['update'] = null;
				if (choice.mode === 'update') {
					const changed = correctionFields(baseline, record.source, record.time);
					const description = changed.descriptionChanged ? record.source.description : target.entry.description;
					if (changed.timeChanged) reserveAllocations(clockifyAllocationDays(record.time));
					savedAllocations += await countClockifyCorrectionAllocations(transaction, accountId, target.entryId);
					if (savedAllocations > maxCorrectionSavedAllocations) {
						throw new ApiRequestError(422, 'CLOCKIFY_IMPORT_TOO_LARGE', 'Review corrections for up to 8000 previously saved day allocations at a time.');
					}
					const current = await loadClockifyCorrectionEntry(transaction, accountId, target.entryId);
					try {
						const time = changed.timeChanged ? clockifyEntryTime(record.time) : undefined;
						const { edit, proposal } = await prepareClockifyCorrection(transaction, accountId, current, description, time,
							changed.timeChanged ? record.time.kind : undefined);
						correction.proposed = proposal;
						if (edit.overlap && !choice.confirmOverlap) {
							return { ...reviewRow(row, 'blocked', ['correction-overlap']), correction };
						}
						if (!edit.changed) return { ...reviewRow(row, 'blocked', ['correction-no-change']), correction };
						update = { description, changeTime: changed.timeChanged, before: correctionSnapshot(current) };
					} catch (error) {
						if (!(error instanceof ApiRequestError)) throw error;
						return { ...reviewRow(row, 'blocked', ['invalid-correction']), correction };
					}
				}
				correctedTargets.add(target.entryId);
				corrections.push({ ...record, occurrence: slot.occurrence, resolution: choice.mode,
					target: { entryId: target.entryId, revision: target.entry.revision, fingerprint: target.fingerprint, occurrence: target.occurrence }, update });
				return { ...reviewRow(row, choice.mode === 'keep' ? 'kept-existing' : 'updated-existing'), correction };
			}
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

		if (!incomplete) reserveAllocations(clockifyAllocationDays(record.time));
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
	}
	// A correction can overlap work introduced by the same batch, which is not
	// yet present in the database during review. Match the final batch intervals.
	const plannedTimes = [...entries, ...corrections.filter(({ update }) => update?.changeTime)];
	for (const correction of corrections) {
		if (!correction.update?.changeTime || correction.time.kind !== 'timed') continue;
		const row = rows.find(({ line }) => line === correction.line)!;
		const proposal = row.correction?.proposed;
		if (!proposal) continue;
		const overlap = plannedTimes.some(({ line, time }) => line !== correction.line && time.kind === 'timed'
			&& time.sourceStartAt < correction.time.sourceEndAt && time.sourceEndAt > correction.time.sourceStartAt);
		if (!overlap) continue;
		proposal.overlap = true;
		const decision = decisions.get(correction.line)?.correction;
		if (decision?.mode === 'update' && !decision.confirmOverlap) {
			row.status = 'blocked';
			row.issues = ['correction-overlap'];
		}
	}

	const creations = clockifyCatalogCreations(entries.map(({ association }) => association));
	if (creations.conflictingNames) {
		throw new ApiRequestError(422, 'CLOCKIFY_INVALID_DECISIONS', 'Use one consistent spelling for each new client and project name.');
	}
	const counts = { new: 0, alreadyImported: 0, excluded: 0, duplicateOmitted: 0, keptExisting: 0, updatedExisting: 0, blocked: 0, incomplete: 0, invoiced: 0 };
	for (const row of rows) {
		if (row.status === 'already-imported') counts.alreadyImported += 1;
		else if (row.status === 'duplicate-omitted') counts.duplicateOmitted += 1;
		else if (row.status === 'kept-existing') counts.keptExisting += 1;
		else if (row.status === 'updated-existing') counts.updatedExisting += 1;
		else counts[row.status] += 1;
		if (row.status === 'new' && row.incomplete) counts.incomplete += 1;
		if (row.status === 'new' && row.invoiced) counts.invoiced += 1;
	}
	return { entries, corrections, existingSlots, review: {
		canCommit: counts.blocked === 0 && (counts.new > 0 || counts.alreadyImported > 0 || corrections.length > 0), counts, rows, duplicateGroups,
		createClients: creations.clients, createProjects: creations.projects,
	} };
}
