import { ClockifyImportReviewBody, ClockifyImportReviewResponse, ClockifySource, EntryResponse } from '@timekeeper/contracts';
import { Type } from '@sinclair/typebox';
import type { TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

const text = Type.String();
const number = Type.Integer();
const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
const version = Type.Literal(1);
const sourceSnapshot = Type.Object({ version, source: ClockifySource, sourceTimeZone: text, sourceStartAt: text, sourceEndAt: text });
const historySnapshot = Type.Object({ version, entry: EntryResponse });
const savedAllocation = Type.Object({ localDate: text, seconds: number, amountOre: text, calculationVersion: number });
const savedWork = Type.Object({ entry: EntryResponse, allocations: Type.Array(savedAllocation) });
const update = Type.Object({ entryId: text, before: savedWork, after: savedWork });
const decisionFields = ClockifyImportReviewBody.properties;
const batchDecisions = Type.Object({
	defaults: decisionFields.defaults,
	rows: decisionFields.rows,
	multiplicities: decisionFields.multiplicities,
});
const review = ClockifyImportReviewResponse.properties;
const batchReview = Type.Object({
	canCommit: review.canCommit,
	counts: Type.Partial(review.counts),
	rows: Type.Array(Type.Partial(review.rows.items)),
	duplicateGroups: Type.Optional(review.duplicateGroups),
	createClients: review.createClients,
	createProjects: Type.Array(Type.Partial(review.createProjects.items)),
});
const batchSnapshot = Type.Object({
	version,
	sourceTimeZone: text,
	decisions: batchDecisions,
	review: batchReview,
	correctionUpdates: Type.Optional(Type.Array(update)),
});
const alias = Type.Object({
	accountId: text, fingerprint: text, occurrence: number, candidateKey: text, targetFingerprint: text,
	targetOccurrence: number, batchId: text, resolution: text, sourceSnapshot,
});
const undoSnapshot = Type.Object({
	version,
	aliases: Type.Array(alias),
	roots: Type.Array(Type.Object({ fingerprint: text, occurrence: number, entryId: text })),
});

function projectValue(schema: TSchema, input: unknown): unknown {
	if (schema.anyOf) {
		for (const alternative of schema.anyOf as TSchema[]) {
			const value = projectValue(alternative, input);
			if (Value.Check(alternative, value)) return value;
		}
		return undefined;
	}
	if (schema.type === 'array') {
		return Array.isArray(input) ? input.map((item) => projectValue(schema.items, item)) : input;
	}
	if (schema.type !== 'object' || !input || typeof input !== 'object' || Array.isArray(input)) return input;
	return Object.fromEntries(Object.entries(schema.properties as Record<string, TSchema>)
		.filter(([key]) => Object.hasOwn(input, key))
		.map(([key, property]) => [key, projectValue(property, (input as Record<string, unknown>)[key])]));
}

function project<T extends TSchema>(schema: T, input: unknown) {
	const value = projectValue(schema, input);
	if (!Value.Check(schema, value)) throw new Error('Unrecognized export snapshot');
	return value;
}

const nullableHistorySnapshot = nullable(historySnapshot);

function decodeSnapshot(value: string) {
	return JSON.parse(value) as unknown;
}

export function exportHistorySnapshot(snapshot: string | null) {
	return project(nullableHistorySnapshot, snapshot === null ? null : decodeSnapshot(snapshot));
}

export function exportSourceSnapshot(snapshot: string) {
	return project(sourceSnapshot, decodeSnapshot(snapshot));
}

export function exportBatchSnapshot(snapshot: string) {
	return project(batchSnapshot, decodeSnapshot(snapshot));
}

export function exportUndoSnapshot(snapshot: string | null) {
	if (snapshot === null) return null;
	const value = decodeSnapshot(snapshot);
	if (value && typeof value === 'object' && 'aliases' in value && Array.isArray(value.aliases)) {
		for (const item of value.aliases) {
			if (item && typeof item === 'object' && typeof item.sourceSnapshot === 'string') {
				item.sourceSnapshot = exportSourceSnapshot(item.sourceSnapshot);
			}
		}
	}
	return project(undoSnapshot, value);
}
