import { randomUUID } from 'node:crypto';
import { maxCatalogNameLength, maxCatalogNotesLength, maxHourlyRateOre } from '@timekeeper/contracts';
import type {
	CatalogListQuery,
	ClientResponse,
	CreateClientBody,
	CreateProjectBody,
	ProjectResponse,
	UpdateClientBody,
	UpdateProjectBody,
} from '@timekeeper/contracts';
import type { Client, Prisma, PrismaClient, Project } from '../generated/prisma/client.ts';

export class CatalogError extends Error {
	constructor(
		readonly status: 401 | 404 | 409 | 422,
		readonly code: string,
		message: string,
		readonly field?: string,
	) {
		super(message);
	}
}

type CatalogView = CatalogListQuery['view'];
type ProjectWithRate = Project & { client: { defaultRateOrePerHour: bigint | null } | null };

const projectClientRate = { client: { select: { defaultRateOrePerHour: true } } } as const;
const orderBy = [{ name: 'asc' }, { id: 'asc' }] satisfies Prisma.ClientOrderByWithRelationInput[];
const maxRate = BigInt(maxHourlyRateOre);

function clientResponse(client: Client): ClientResponse {
	return {
		id: client.id,
		name: client.name,
		notes: client.notes,
		defaultRateOrePerHour: client.defaultRateOrePerHour?.toString() ?? null,
		archivedAt: client.archivedAt?.toISOString() ?? null,
		revision: client.revision,
	};
}

function projectResponse(project: ProjectWithRate): ProjectResponse {
	const effectiveRate = project.rateOverrideOrePerHour ?? project.client?.defaultRateOrePerHour;
	return {
		id: project.id,
		clientId: project.clientId,
		name: project.name,
		notes: project.notes,
		rateOverrideOrePerHour: project.rateOverrideOrePerHour?.toString() ?? null,
		effectiveRateOrePerHour: effectiveRate?.toString() ?? null,
		defaultBillable: project.defaultBillable,
		archivedAt: project.archivedAt?.toISOString() ?? null,
		revision: project.revision,
	};
}

function catalogText(input: { name: string; notes: string | null }) {
	const name = input.name.trim();
	const notes = input.notes?.trim() || null;
	if (!name || [...name].length > maxCatalogNameLength) {
		throw new CatalogError(422, 'INVALID_NAME', `Enter a name up to ${maxCatalogNameLength} characters.`, 'name');
	}
	if (notes && [...notes].length > maxCatalogNotesLength) {
		throw new CatalogError(422, 'INVALID_NOTES', `Enter up to ${maxCatalogNotesLength} characters of notes.`, 'notes');
	}
	return { name, notes };
}

function nameKey(name: string) {
	return name.trim().toLowerCase().normalize('NFC');
}

function hourlyRate(rate: string | null, field: 'defaultRateOrePerHour' | 'rateOverrideOrePerHour') {
	if (rate === null) {
		return null;
	}
	const value = BigInt(rate);
	if (value > maxRate) {
		throw new CatalogError(422, 'INVALID_HOURLY_RATE', 'The hourly rate exceeds the supported maximum.', field);
	}
	return value;
}

function checkRevision<T extends { revision: number }>(record: T | null, expected: number, resource: 'Client' | 'Project'): T {
	if (!record) {
		throw new CatalogError(404, 'NOT_FOUND', `${resource} was not found.`);
	}
	if (record.revision !== expected) {
		throw new CatalogError(409, 'REVISION_CONFLICT', `${resource} changed. Reload and try again.`);
	}
	return record;
}

async function warnDuplicateClient(transaction: Prisma.TransactionClient, accountId: string, name: string, id?: string) {
	const key = nameKey(name);
	const candidates = await transaction.client.findMany({
		where: { accountId, id: id ? { not: id } : undefined },
		select: { name: true },
	});
	if (candidates.some((client) => nameKey(client.name) === key)) {
		throw new CatalogError(409, 'DUPLICATE_CLIENT_NAME', 'A client already uses this name.', 'name');
	}
}

async function warnDuplicateProject(
	transaction: Prisma.TransactionClient, accountId: string, clientId: string | null, name: string, id?: string,
) {
	const key = nameKey(name);
	const candidates = await transaction.project.findMany({
		where: { accountId, clientId, id: id ? { not: id } : undefined },
		select: { name: true },
	});
	if (candidates.some((project) => nameKey(project.name) === key)) {
		throw new CatalogError(409, 'DUPLICATE_PROJECT_NAME', 'A project already uses this name for the selected client.', 'name');
	}
}

async function requireActiveClient(transaction: Prisma.TransactionClient, accountId: string, clientId: string | null) {
	if (clientId === null) {
		return;
	}
	const client = await transaction.client.findUnique({
		where: { id: clientId, accountId, archivedAt: null },
		select: { id: true },
	});
	if (!client) {
		throw new CatalogError(422, 'INVALID_CLIENT', 'Choose an active client or leave the project without a client.', 'clientId');
	}
}

export function createCatalogStore(database: PrismaClient) {
	function mutate<T>(accountId: string, operation: (transaction: Prisma.TransactionClient) => Promise<T>) {
		return database.$transaction(async (transaction) => {
			// Start with a write so SQLite acquires the writer lock before the duplicate, client and revision reads.
			const matched = await transaction.$executeRaw`UPDATE "Account" SET "updatedAt" = "updatedAt" WHERE "id" = ${accountId}`;
			if (matched !== 1) {
				throw new CatalogError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
			}
			return operation(transaction);
		});
	}

	return {
		async listClients(accountId: string, view: CatalogView) {
			const records = await database.client.findMany({
				where: { accountId, archivedAt: view === 'management' ? undefined : null },
				orderBy,
			});
			return records.map(clientResponse);
		},

		async listProjects(accountId: string, view: CatalogView) {
			const records = await database.$transaction((transaction) => transaction.project.findMany({
				where: view === 'management' ? { accountId } : {
					accountId,
					archivedAt: null,
					OR: [{ clientId: null }, { client: { is: { accountId, archivedAt: null } } }],
				},
				include: projectClientRate,
				orderBy,
			}));
			return records.map(projectResponse);
		},

		createClient(accountId: string, input: CreateClientBody) {
			const text = catalogText(input);
			const defaultRateOrePerHour = hourlyRate(input.defaultRateOrePerHour, 'defaultRateOrePerHour');
			return mutate(accountId, async (transaction) => {
				if (!input.confirmDuplicate) {
					await warnDuplicateClient(transaction, accountId, text.name);
				}
				const record = await transaction.client.create({
					data: { id: randomUUID(), accountId, ...text, defaultRateOrePerHour },
				});
				return clientResponse(record);
			});
		},

		updateClient(accountId: string, id: string, input: UpdateClientBody) {
			const text = catalogText(input);
			const defaultRateOrePerHour = hourlyRate(input.defaultRateOrePerHour, 'defaultRateOrePerHour');
			return mutate(accountId, async (transaction) => {
				const where = { id, accountId };
				const current = checkRevision(await transaction.client.findUnique({ where }), input.revision, 'Client');
				if (!input.confirmDuplicate && nameKey(current.name) !== nameKey(text.name)) {
					await warnDuplicateClient(transaction, accountId, text.name, id);
				}
				const record = await transaction.client.update({
					where: { ...where, revision: input.revision },
					data: { ...text, defaultRateOrePerHour, revision: { increment: 1 } },
				});
				return clientResponse(record);
			});
		},

		setClientArchived(accountId: string, id: string, revision: number, archive: boolean) {
			return mutate(accountId, async (transaction) => {
				const where = { id, accountId };
				const current = checkRevision(await transaction.client.findUnique({ where }), revision, 'Client');
				if (Boolean(current.archivedAt) === archive) {
					return clientResponse(current);
				}
				const record = await transaction.client.update({
					where: { ...where, revision },
					data: { archivedAt: archive ? new Date() : null, revision: { increment: 1 } },
				});
				return clientResponse(record);
			});
		},

		createProject(accountId: string, input: CreateProjectBody) {
			const text = catalogText(input);
			const rateOverrideOrePerHour = hourlyRate(input.rateOverrideOrePerHour, 'rateOverrideOrePerHour');
			const { clientId, defaultBillable = true } = input;
			return mutate(accountId, async (transaction) => {
				await requireActiveClient(transaction, accountId, clientId);
				if (!input.confirmDuplicate) {
					await warnDuplicateProject(transaction, accountId, clientId, text.name);
				}
				const record = await transaction.project.create({
					data: { id: randomUUID(), accountId, clientId, ...text, rateOverrideOrePerHour, defaultBillable },
					include: projectClientRate,
				});
				return projectResponse(record);
			});
		},

		updateProject(accountId: string, id: string, input: UpdateProjectBody) {
			const text = catalogText(input);
			const rateOverrideOrePerHour = hourlyRate(input.rateOverrideOrePerHour, 'rateOverrideOrePerHour');
			const { clientId, defaultBillable, revision } = input;
			return mutate(accountId, async (transaction) => {
				const where = { id, accountId };
				const current = checkRevision(await transaction.project.findUnique({ where }), revision, 'Project');
				const changedClient = current.clientId !== clientId;
				if (changedClient) {
					// Issue #6 must check for existing entries here in the same transaction as the reassignment.
					await requireActiveClient(transaction, accountId, clientId);
				}
				if (!input.confirmDuplicate && (changedClient || nameKey(current.name) !== nameKey(text.name))) {
					await warnDuplicateProject(transaction, accountId, clientId, text.name, id);
				}
				const record = await transaction.project.update({
					where: { ...where, revision },
					data: { clientId, ...text, rateOverrideOrePerHour, defaultBillable, revision: { increment: 1 } },
					include: projectClientRate,
				});
				return projectResponse(record);
			});
		},

		setProjectArchived(accountId: string, id: string, revision: number, archive: boolean) {
			return mutate(accountId, async (transaction) => {
				const where = { id, accountId };
				const current = checkRevision(await transaction.project.findUnique({ where, include: projectClientRate }), revision, 'Project');
				if (Boolean(current.archivedAt) === archive) {
					return projectResponse(current);
				}
				const record = await transaction.project.update({
					where: { ...where, revision },
					data: { archivedAt: archive ? new Date() : null, revision: { increment: 1 } },
					include: projectClientRate,
				});
				return projectResponse(record);
			});
		},
	};
}

export type CatalogStore = ReturnType<typeof createCatalogStore>;
