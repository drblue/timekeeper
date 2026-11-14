import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { maxCatalogNameLength } from './catalog.js';
import { NullableHourlyRate, NullableUuid, Revision, Uuid } from './primitives.js';

export const clockifyPreviewPath = '/api/v1/imports/clockify/preview';
export const maxClockifyCsvBytes = 4 * 1024 * 1024;
export const maxClockifyRows = 4_000;

const strict = { additionalProperties: false };
const Text = Type.String();
const Count = Type.Integer({ minimum: 0 });
const Sha256 = Type.String({ pattern: '^[0-9a-f]{64}$' });
const TimeZone = Type.String({ minLength: 1, maxLength: 128 });
const NullableSeconds = Type.Union([Type.Integer(), Type.Null()]);

export const ClockifyPreviewQuery = Type.Object({
	sourceTimeZone: Type.Optional(TimeZone),
	selectedUserId: Type.Optional(Sha256),
}, strict);

export const ClockifySource = Type.Object({
	project: Text,
	client: Text,
	description: Text,
	task: Text,
	user: Text,
	group: Text,
	email: Text,
	tags: Text,
	startDate: Text,
	startTime: Text,
	endDate: Text,
	endTime: Text,
	durationH: Text,
	durationDecimal: Text,
	dateOfCreation: Text,
}, strict);

export const ClockifyTimestamp = Type.Object({
	local: Type.Union([Text, Type.Null()]),
	status: Type.Union([Type.Literal('valid'), Type.Literal('ambiguous'), Type.Literal('nonexistent'), Type.Literal('invalid')]),
	candidates: Type.Array(Type.Object({
		occurrence: Type.Union([Type.Literal('earlier'), Type.Literal('later'), Type.Null()]),
		instant: Text,
		offset: Text,
	}, strict), { maxItems: 2 }),
}, strict);

export const ClockifyRowIssue = Type.Union([
	Type.Literal('column-count'), Type.Literal('missing-user'), Type.Literal('missing-description'), Type.Literal('invalid-duration'),
	Type.Literal('invalid-start'), Type.Literal('invalid-end'), Type.Literal('ambiguous-start'), Type.Literal('ambiguous-end'),
	Type.Literal('nonexistent-start'), Type.Literal('nonexistent-end'), Type.Literal('nonpositive-interval'), Type.Literal('duration-mismatch'),
]);

export const ClockifyPreviewRow = Type.Object({
	line: Type.Integer({ minimum: 2 }),
	source: Type.Union([ClockifySource, Type.Null()]),
	invoicedTag: Type.Union([Type.Boolean(), Type.Null()]),
	durationSeconds: NullableSeconds,
	start: Type.Union([ClockifyTimestamp, Type.Null()]),
	end: Type.Union([ClockifyTimestamp, Type.Null()]),
	timestampDurationSeconds: NullableSeconds,
	issues: Type.Array(ClockifyRowIssue),
	status: Type.Union([Type.Literal('valid'), Type.Literal('review'), Type.Literal('invalid')]),
}, strict);

export const ClockifyPreviewResponse = Type.Object({
	sourceTimeZone: TimeZone,
	users: Type.Array(Type.Object({ id: Sha256, user: Text, email: Text, rowCount: Count }, strict), { maxItems: maxClockifyRows }),
	selectedUserId: Type.Union([Sha256, Type.Null()]),
	requiresUserSelection: Type.Boolean(),
	counts: Type.Object({ total: Count, selected: Count, valid: Count, review: Count, invalid: Count, unassigned: Count }, strict),
	rows: Type.Array(ClockifyPreviewRow, { maxItems: maxClockifyRows }),
}, strict);

export type ClockifyPreviewQuery = Static<typeof ClockifyPreviewQuery>;
export type ClockifySource = Static<typeof ClockifySource>;
export type ClockifyTimestamp = Static<typeof ClockifyTimestamp>;
export type ClockifyRowIssue = Static<typeof ClockifyRowIssue>;
export type ClockifyPreviewRow = Static<typeof ClockifyPreviewRow>;
export type ClockifyPreviewResponse = Static<typeof ClockifyPreviewResponse>;

export function parseClockifyPreviewResponse(value: unknown): ClockifyPreviewResponse {
	if (!Value.Check(ClockifyPreviewResponse, value)) throw new Error('Invalid Clockify inspection response');
	return value;
}

export const clockifyStagePath = '/api/v1/imports/clockify/stage';
export const clockifyReviewPath = '/api/v1/imports/clockify/review';
export const clockifyCommitPath = '/api/v1/imports/clockify/commit';

export const ClockifyStageResponse = Type.Object({
	stageId: Uuid,
	expiresAt: Text,
	inspection: ClockifyPreviewResponse,
}, strict);

const CatalogChoice = Type.Union([
	Type.Object({ mode: Type.Literal('none') }, strict),
	Type.Object({ mode: Type.Literal('existing'), id: Uuid, revision: Revision }, strict),
	Type.Object({ mode: Type.Literal('create'), name: Type.String({ minLength: 1, maxLength: maxCatalogNameLength }) }, strict),
]);

export const ClockifyImportAssociation = Type.Object({ client: CatalogChoice, project: CatalogChoice }, strict);
export const ClockifyImportBilling = Type.Union([
	Type.Object({ mode: Type.Literal('non-billable') }, strict),
	Type.Object({ mode: Type.Literal('billable'), rateOrePerHour: NullableHourlyRate }, strict),
]);
const mappingFields = {
	association: Type.Optional(ClockifyImportAssociation),
	billing: Type.Optional(ClockifyImportBilling),
};
const Occurrence = Type.Union([Type.Literal('earlier'), Type.Literal('later')]);
export const ClockifyImportRowDecision = Type.Object({
	line: Type.Integer({ minimum: 2, maximum: maxClockifyCsvBytes + 1 }),
	...mappingFields,
	exclude: Type.Optional(Type.Boolean()),
	acceptIncomplete: Type.Optional(Type.Boolean()),
	startOccurrence: Type.Optional(Occurrence),
	endOccurrence: Type.Optional(Occurrence),
	durationChoice: Type.Optional(Type.Union([Type.Literal('use-timestamps'), Type.Literal('duration-only')])),
}, strict);

export const ClockifyMultiplicity = Type.Object({
	fingerprint: Sha256,
	count: Type.Integer({ minimum: 1, maximum: maxClockifyRows }),
}, strict);

export const ClockifyImportReviewBody = Type.Object({
	stageId: Uuid,
	defaults: Type.Optional(Type.Object(mappingFields, strict)),
	rows: Type.Array(ClockifyImportRowDecision, { maxItems: maxClockifyRows }),
	multiplicities: Type.Optional(Type.Array(ClockifyMultiplicity, { maxItems: Math.floor(maxClockifyRows / 2) })),
}, strict);

export const ClockifyImportReviewResponse = Type.Object({
	previewToken: NullableUuid,
	expiresAt: Type.Union([Text, Type.Null()]),
	canCommit: Type.Boolean(),
	counts: Type.Object({ new: Count, alreadyImported: Count, excluded: Count, duplicateOmitted: Count, blocked: Count, incomplete: Count, invoiced: Count }, strict),
	rows: Type.Array(Type.Object({
		line: Type.Integer({ minimum: 2 }),
		status: Type.Union([Type.Literal('new'), Type.Literal('already-imported'), Type.Literal('excluded'), Type.Literal('duplicate-omitted'), Type.Literal('blocked')]),
		issues: Type.Array(Text),
		incomplete: Type.Boolean(),
		invoiced: Type.Boolean(),
		approved: Type.Union([Type.Null(), Type.Object({
			clientId: NullableUuid,
			projectId: NullableUuid,
			clientName: Type.Union([Text, Type.Null()]),
			projectName: Type.Union([Text, Type.Null()]),
			billable: Type.Boolean(),
			rateOrePerHour: NullableHourlyRate,
			kind: Type.Union([Type.Literal('timed'), Type.Literal('duration-only')]),
			localDate: Text,
			durationSeconds: Count,
			startAt: Type.Union([Text, Type.Null()]),
			endAt: Type.Union([Text, Type.Null()]),
			amountOre: NullableHourlyRate,
		}, strict)]),
	}, strict), { maxItems: maxClockifyRows }),
	duplicateGroups: Type.Array(Type.Object({
		fingerprint: Sha256,
		lines: Type.Array(Type.Integer({ minimum: 2 }), { minItems: 2, maxItems: maxClockifyRows }),
		existingCount: Count,
		selectedCount: Count,
		newCount: Count,
	}, strict), { maxItems: Math.floor(maxClockifyRows / 2) }),
	createClients: Type.Array(Type.Object({ name: Text }, strict)),
	createProjects: Type.Array(Type.Object({ name: Text, clientId: NullableUuid, clientName: Type.Union([Text, Type.Null()]) }, strict)),
}, strict);

export const ClockifyImportCommitBody = Type.Object({ previewToken: Uuid }, strict);
export const ClockifyImportCommitResponse = Type.Object({
	batchId: NullableUuid,
	createdCount: Count,
	alreadyImportedCount: Count,
	excludedCount: Count,
	duplicateOmittedCount: Type.Optional(Count),
	incompleteCount: Count,
	invoicedCount: Count,
	serverNow: Text,
}, strict);

export type ClockifyStageResponse = Static<typeof ClockifyStageResponse>;
export type ClockifyImportAssociation = Static<typeof ClockifyImportAssociation>;
export type ClockifyImportBilling = Static<typeof ClockifyImportBilling>;
export type ClockifyImportRowDecision = Static<typeof ClockifyImportRowDecision>;
export type ClockifyMultiplicity = Static<typeof ClockifyMultiplicity>;
export type ClockifyImportReviewBody = Static<typeof ClockifyImportReviewBody>;
export type ClockifyImportReviewResponse = Static<typeof ClockifyImportReviewResponse>;
export type ClockifyImportCommitBody = Static<typeof ClockifyImportCommitBody>;
export type ClockifyImportCommitResponse = Static<typeof ClockifyImportCommitResponse>;

export function parseClockifyStageResponse(value: unknown): ClockifyStageResponse {
	if (!Value.Check(ClockifyStageResponse, value)) throw new Error('Invalid Clockify stage response');
	return value;
}

export function parseClockifyImportReviewResponse(value: unknown): ClockifyImportReviewResponse {
	if (!Value.Check(ClockifyImportReviewResponse, value)) throw new Error('Invalid Clockify review response');
	return value;
}

export function parseClockifyImportCommitResponse(value: unknown): ClockifyImportCommitResponse {
	if (!Value.Check(ClockifyImportCommitResponse, value)) throw new Error('Invalid Clockify commit response');
	return value;
}
