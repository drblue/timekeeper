import { Type } from '@sinclair/typebox';
import type { Static, TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { NullableHourlyRate, NullableUuid, Revision, Uuid } from './primitives.js';

export const clientsPath = '/api/v1/clients';
export const projectsPath = '/api/v1/projects';
export const maxCatalogNameLength = 160;

export function catalogNameKey(name: string) {
	return name.trim().toLowerCase().normalize('NFC');
}
export const maxCatalogNotesLength = 4_000;
export const maxHourlyRateOre = '9223372036854775807';

const Name = Type.String({ minLength: 1, maxLength: maxCatalogNameLength });
const Notes = Type.Union([Type.String({ maxLength: maxCatalogNotesLength }), Type.Null()]);
const ArchivedAt = Type.Union([
	Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$' }),
	Type.Null(),
]);

const ClientFields = { name: Name, notes: Notes, defaultRateOrePerHour: NullableHourlyRate };
const ProjectFields = { name: Name, notes: Notes, clientId: NullableUuid, rateOverrideOrePerHour: NullableHourlyRate };
// Input lengths use JSON Schema code points. TypeBox's response checks count UTF-16 code units.
const ResponseTextFields = { name: Type.String({ minLength: 1 }), notes: Type.Union([Type.String(), Type.Null()]) };
const ConfirmDuplicate = Type.Optional(Type.Boolean());
const strict = { additionalProperties: false };

export const CatalogListQuery = Type.Object({
	view: Type.Optional(Type.Union([Type.Literal('active'), Type.Literal('management')])),
}, strict);
export const CatalogIdParams = Type.Object({ id: Uuid }, strict);
export const CatalogLifecycleBody = Type.Object({ revision: Revision }, strict);
export const CreateClientBody = Type.Object({ ...ClientFields, confirmDuplicate: ConfirmDuplicate }, strict);
export const UpdateClientBody = Type.Object({ ...ClientFields, revision: Revision, confirmDuplicate: ConfirmDuplicate }, strict);
export const CreateProjectBody = Type.Object({
	...ProjectFields,
	defaultBillable: Type.Optional(Type.Boolean()),
	confirmDuplicate: ConfirmDuplicate,
}, strict);
export const UpdateProjectBody = Type.Object({
	...ProjectFields,
	defaultBillable: Type.Boolean(),
	revision: Revision,
	confirmDuplicate: ConfirmDuplicate,
}, strict);

export const ClientResponse = Type.Object({
	id: Uuid,
	...ClientFields,
	...ResponseTextFields,
	archivedAt: ArchivedAt,
	revision: Revision,
}, strict);
export const ProjectResponse = Type.Object({
	id: Uuid,
	...ProjectFields,
	...ResponseTextFields,
	effectiveRateOrePerHour: NullableHourlyRate,
	defaultBillable: Type.Boolean(),
	archivedAt: ArchivedAt,
	revision: Revision,
}, strict);
export const ClientListResponse = Type.Array(ClientResponse);
export const ProjectListResponse = Type.Array(ProjectResponse);

export type CatalogListQuery = Static<typeof CatalogListQuery>;
export type CatalogIdParams = Static<typeof CatalogIdParams>;
export type CatalogLifecycleBody = Static<typeof CatalogLifecycleBody>;
export type CreateClientBody = Static<typeof CreateClientBody>;
export type UpdateClientBody = Static<typeof UpdateClientBody>;
export type CreateProjectBody = Static<typeof CreateProjectBody>;
export type UpdateProjectBody = Static<typeof UpdateProjectBody>;
export type ClientResponse = Static<typeof ClientResponse>;
export type ProjectResponse = Static<typeof ProjectResponse>;

function parseCatalogResponse<T extends TSchema>(schema: T, value: unknown): Static<T> {
	if (!Value.Check(schema, value)) {
		throw new Error('Invalid client or project response');
	}
	return value;
}

export function parseClientResponse(value: unknown): ClientResponse {
	return parseCatalogResponse(ClientResponse, value);
}

export function parseProjectResponse(value: unknown): ProjectResponse {
	return parseCatalogResponse(ProjectResponse, value);
}

export function parseClientListResponse(value: unknown): ClientResponse[] {
	return parseCatalogResponse(ClientListResponse, value);
}

export function parseProjectListResponse(value: unknown): ProjectResponse[] {
	return parseCatalogResponse(ProjectListResponse, value);
}
