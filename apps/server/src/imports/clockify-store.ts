import { randomUUID } from 'node:crypto';
import { parseClockifyImportCommitResponse, parseClockifyPreviewResponse } from '@timekeeper/contracts';
import type { ClockifyCorrectionTargetsQuery, ClockifyImportReviewBody, ClockifyPreviewQuery } from '@timekeeper/contracts';
import { writeForAccount } from '../account-write.ts';
import { ApiRequestError } from '../api-error.ts';
import { replaceEntry, writeEntry } from '../entries/store.ts';
import type { PrismaClient } from '../generated/prisma/client.ts';
import { writeWithReceipt } from '../operation-receipt.ts';
import { createClockifyAssociations } from './clockify-association.ts';
import { clockifyHash } from './clockify-identity.ts';
import { correctionSnapshot, loadClockifyCorrectionEntry, prepareClockifyCorrection, searchClockifyCorrectionTargets } from './clockify-corrections.ts';
import { clockifyEntryTime, planClockifyImport } from './clockify-plan.ts';
import { previewClockify } from './clockify-preview.ts';

const stageLifetime = 30 * 60 * 1_000;
const reviewLifetime = 15 * 60 * 1_000;
const maxActiveStages = 4;
const maxActivePreviews = 8;
const commitTimeoutMs = 30_000;
const maxStageBytes = 12 * 1024 * 1024;
export const maxClockifyReviewBytes = 2 * 1024 * 1024;

function stageExpired(): never {
	throw new ApiRequestError(409, 'CLOCKIFY_STAGE_EXPIRED', 'The CSV stage expired. Upload the file again.');
}

function previewChanged(): never {
	throw new ApiRequestError(409, 'CLOCKIFY_PREVIEW_CHANGED', 'The import plan changed. Review the mapping and try again.');
}

function readInspection(snapshot: string) {
	const { version, inspection } = JSON.parse(snapshot);
	if (version !== 1) throw new Error('Invalid Clockify import stage version');
	return parseClockifyPreviewResponse(inspection);
}

export function createClockifyImportStore(database: PrismaClient, now: () => Date = () => new Date()) {
	return {
		correctionTargets(accountId: string, query: ClockifyCorrectionTargetsQuery) {
			return database.$transaction((transaction) => searchClockifyCorrectionTargets(transaction, accountId, query));
		},

		async stage(accountId: string, bytes: Buffer, query: ClockifyPreviewQuery) {
			const inspection = previewClockify(bytes, query);
			if (inspection.requiresUserSelection) {
				throw new ApiRequestError(422, 'CLOCKIFY_USER_REQUIRED', 'Choose one source user before staging this CSV.');
			}
			const snapshot = JSON.stringify({ version: 1, inspection });
			if (Buffer.byteLength(snapshot) > maxStageBytes) {
				throw new ApiRequestError(422, 'CLOCKIFY_IMPORT_TOO_LARGE', 'Choose a smaller CSV export to stage.');
			}
			return writeForAccount(database, accountId, async (transaction) => {
				const instant = now();
				await transaction.clockifyImportStage.deleteMany({ where: { accountId, expiresAt: { lte: instant } } });
				const existing = await transaction.clockifyImportStage.findFirst({
					where: { accountId, snapshot }, select: { id: true, expiresAt: true },
				});
				if (existing) return { stageId: existing.id, expiresAt: existing.expiresAt.toISOString(), inspection };
				const active = await transaction.clockifyImportStage.count({ where: { accountId } });
				if (active >= maxActiveStages) {
					throw new ApiRequestError(429, 'CLOCKIFY_STAGE_LIMIT', 'Too many recent CSV stages. Wait for one to expire.');
				}
				const expiresAt = new Date(instant.getTime() + stageLifetime);
				const id = randomUUID();
				await transaction.clockifyImportStage.create({ data: { id, accountId, snapshot, expiresAt } });
				return { stageId: id, expiresAt: expiresAt.toISOString(), inspection };
			});
		},

		review(accountId: string, input: ClockifyImportReviewBody) {
			return writeForAccount(database, accountId, async (transaction) => {
				const instant = now();
				const stage = await transaction.clockifyImportStage.findUnique({ where: { id: input.stageId, accountId } });
				if (!stage) throw new ApiRequestError(404, 'CLOCKIFY_STAGE_NOT_FOUND', 'The CSV stage could not be found.');
				if (stage.expiresAt <= instant) stageExpired();
				const plan = await planClockifyImport(transaction, accountId, readInspection(stage.snapshot), input);
				if (!plan.review.canCommit) return { ...plan.review, previewToken: null, expiresAt: null };
				const decisions = JSON.stringify(input);
				const planHash = clockifyHash([3, stage.id, plan]);
				if (Buffer.byteLength(decisions) > maxClockifyReviewBytes) {
					throw new ApiRequestError(422, 'CLOCKIFY_IMPORT_TOO_LARGE', 'Choose a smaller selection to review.');
				}
				await transaction.clockifyImportPreview.deleteMany({ where: { accountId, expiresAt: { lte: instant } } });
				const existing = await transaction.clockifyImportPreview.findFirst({
					where: { accountId, stageId: stage.id, decisions, planHash, consumedAt: null },
					select: { id: true, expiresAt: true },
				});
				if (existing) return { ...plan.review, previewToken: existing.id, expiresAt: existing.expiresAt.toISOString() };
				if (await transaction.clockifyImportPreview.count({ where: { accountId } }) >= maxActivePreviews) {
					throw new ApiRequestError(429, 'CLOCKIFY_PREVIEW_LIMIT', 'Too many recent import reviews. Wait for one to expire.');
				}
				const id = randomUUID();
				const expiresAt = new Date(Math.min(stage.expiresAt.getTime(), instant.getTime() + reviewLifetime));
				await transaction.clockifyImportPreview.create({
					data: { id, accountId, stageId: stage.id, expiresAt, decisions, planHash },
				});
				return { ...plan.review, previewToken: id, expiresAt: expiresAt.toISOString() };
			});
		},

		commit(accountId: string, key: string, previewToken: string) {
			return writeWithReceipt(database, accountId, key, ['clockify.import', previewToken], parseClockifyImportCommitResponse, async (transaction) => {
				const instant = now();
				const preview = await transaction.clockifyImportPreview.findUnique({ where: { id: previewToken, accountId }, include: { stage: true } });
				if (!preview || preview.expiresAt <= instant) {
					throw new ApiRequestError(409, 'CLOCKIFY_PREVIEW_EXPIRED', 'The import review expired. Review the staged CSV again.');
				}
				if (preview.consumedAt) previewChanged();
				const inspection = readInspection(preview.stage.snapshot);
				const decisions = JSON.parse(preview.decisions) as ClockifyImportReviewBody;
				const plan = await planClockifyImport(transaction, accountId, inspection, decisions);
				if (!plan.review.canCommit || clockifyHash([3, preview.stageId, plan]) !== preview.planHash) previewChanged();
				const { counts } = plan.review;
				const batchId = plan.entries.length || plan.corrections.length ? randomUUID() : null;
				if (batchId) {
					const batchSnapshot = { version: 1, sourceTimeZone: inspection.sourceTimeZone, decisions, review: plan.review };
					const correctionUpdates = [];
					await transaction.clockifyImportBatch.create({ data: {
						id: batchId, accountId, committedAt: instant,
						snapshot: JSON.stringify(batchSnapshot),
					} });
					for (const planned of plan.corrections) {
						const { target, update } = planned;
						if (update) {
							const current = await loadClockifyCorrectionEntry(transaction, accountId, target.entryId);
							if (current.revision !== target.revision) previewChanged();
							const { edit } = await prepareClockifyCorrection(transaction, accountId, current, update.description,
								update.changeTime ? clockifyEntryTime(planned.time) : undefined, update.changeTime ? planned.time.kind : undefined);
							const entry = await replaceEntry(transaction, current, edit.kind, edit.work, edit.billableAmountOre, edit.time, instant, key);
							const after = await loadClockifyCorrectionEntry(transaction, accountId, entry.id);
							correctionUpdates.push({ entryId: entry.id, before: update.before, after: correctionSnapshot(after) });
						}
						await transaction.clockifyImportAlias.create({ data: {
							accountId, batchId, fingerprint: planned.fingerprint, occurrence: planned.occurrence,
							candidateKey: planned.candidateKey, targetFingerprint: target.fingerprint, targetOccurrence: target.occurrence,
							resolution: planned.resolution,
							sourceSnapshot: JSON.stringify({ version: 1, source: planned.source, sourceTimeZone: inspection.sourceTimeZone,
								sourceStartAt: planned.time.sourceStartAt, sourceEndAt: planned.time.sourceEndAt }),
						} });
					}
					const createAssociation = createClockifyAssociations(transaction, accountId);
					for (const planned of plan.entries) {
						const { kind, sourceStartAt, sourceEndAt } = planned.time;
						const time = clockifyEntryTime(planned.time, planned.incomplete);
						const association = await createAssociation(planned.association);
						const entry = await writeEntry(transaction, accountId, kind, time, {
							...association, description: planned.description, billable: planned.billable,
							assignedRateOrePerHour: planned.rateOrePerHour === null ? null : BigInt(planned.rateOrePerHour),
						}, instant, { allowIncomplete: planned.incomplete, operationKey: key, invoicedAt: planned.invoiced ? instant : undefined });
						await transaction.clockifyImportIdentity.create({ data: {
							accountId, batchId, entryId: entry.id, entryRevision: entry.revision,
							fingerprint: planned.fingerprint, occurrence: planned.occurrence, candidateKey: planned.candidateKey,
							sourceSnapshot: JSON.stringify({ version: 1, source: planned.source, sourceTimeZone: inspection.sourceTimeZone, sourceStartAt, sourceEndAt }),
						} });
					}
					if (correctionUpdates.length) await transaction.clockifyImportBatch.update({
						where: { id: batchId, accountId }, data: { snapshot: JSON.stringify({ ...batchSnapshot, correctionUpdates }) },
					});
				}
				await transaction.clockifyImportPreview.update({ where: { id: preview.id }, data: { consumedAt: instant } });
				return { batchId, createdCount: counts.new, alreadyImportedCount: counts.alreadyImported, excludedCount: counts.excluded,
					duplicateOmittedCount: counts.duplicateOmitted, keptExistingCount: counts.keptExisting, updatedExistingCount: counts.updatedExisting, incompleteCount: counts.incomplete, invoicedCount: counts.invoiced, serverNow: instant.toISOString() };
			}, commitTimeoutMs);
		},
	};
}
