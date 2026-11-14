import { randomUUID } from 'node:crypto';
import { catalogNameKey } from '@timekeeper/contracts';
import type { ClockifyImportAssociation, ClockifySource } from '@timekeeper/contracts';
import { ApiRequestError } from '../api-error.ts';
import { catalogText } from '../catalog/store.ts';
import type { Prisma } from '../generated/prisma/client.ts';

type CatalogChoice = ClockifyImportAssociation['client'];
type Existing = { mode: 'existing'; id: string; name: string; revision: number };
type Create = { mode: 'create'; name: string };
type Association = Existing | Create | null;
export interface ResolvedClockifyAssociation {
	client: Association;
	project: Association;
}

function matchChoice(
	choice: CatalogChoice, existing: ReadonlyMap<string, Existing & { archivedAt: Date | null }>,
	sameName: (nameKey: string) => boolean,
): Association | undefined {
	switch (choice.mode) {
		case 'none':
			return null;
		case 'existing': {
			const item = existing.get(choice.id);
			if (item && item.archivedAt === null && item.revision === choice.revision) {
				return { mode: 'existing', id: item.id, name: item.name, revision: item.revision };
			}
			return undefined;
		}
		case 'create':
			try {
				const { name } = catalogText({ name: choice.name, notes: null });
				return sameName(catalogNameKey(name)) ? undefined : { mode: 'create', name };
			} catch (error) {
				if (error instanceof ApiRequestError) return undefined;
				throw error;
			}
	}
}

function projectKey(clientKey: string | null, name: string) {
	return JSON.stringify([clientKey, catalogNameKey(name)]);
}

export async function readClockifyAssociations(transaction: Prisma.TransactionClient, accountId: string) {
	const fields = { id: true, name: true, revision: true, archivedAt: true } as const;
	const clients = await transaction.client.findMany({ where: { accountId }, select: fields });
	const projects = await transaction.project.findMany({ where: { accountId }, select: { ...fields, clientId: true } });
	const clientsById = new Map(clients.map((item) => [item.id, { ...item, mode: 'existing' as const }]));
	const projectsById = new Map(projects.map((item) => [item.id, { ...item, mode: 'existing' as const }]));
	const clientNames = new Set(clients.map(({ name }) => catalogNameKey(name)));
	const projectNames = new Set(projects.map(({ clientId, name }) => projectKey(clientId, name)));
	return (choice: ClockifyImportAssociation | undefined, source: ClockifySource):
		ResolvedClockifyAssociation | 'missing-association' | 'invalid-association' => {
		if (!choice) {
			return source.client.trim() || source.project.trim() ? 'missing-association' : { client: null, project: null };
		}
		const client = matchChoice(choice.client, clientsById, (key) => clientNames.has(key));
		if (client === undefined) return 'invalid-association';
		const clientId = client?.mode === 'existing' ? client.id : null;
		const project = matchChoice(choice.project, projectsById, (key) => client?.mode !== 'create' && projectNames.has(projectKey(clientId, key)));
		if (project === undefined || (project?.mode === 'existing'
			&& (client?.mode === 'create' || projectsById.get(project.id)!.clientId !== clientId))) return 'invalid-association';
		return { client, project };
	};
}

function clientReference(client: Association) {
	return client?.mode === 'create' ? 'new:' + catalogNameKey(client.name) : client?.id ?? null;
}

export function clockifyCatalogCreations(associations: ResolvedClockifyAssociation[]) {
	const clients = new Map<string, { name: string }>();
	const projects = new Map<string, { name: string; clientId: string | null; clientName: string | null }>();
	let conflictingNames = false;
	for (const { client, project } of associations) {
		if (client?.mode === 'create') {
			const key = catalogNameKey(client.name);
			const existing = clients.get(key);
			if (existing && existing.name !== client.name) conflictingNames = true;
			else clients.set(key, { name: client.name });
		}
		if (project?.mode === 'create') {
			const key = projectKey(clientReference(client), project.name);
			const existing = projects.get(key);
			if (existing && existing.name !== project.name) conflictingNames = true;
			else projects.set(key, { name: project.name, clientId: client?.mode === 'existing' ? client.id : null, clientName: client?.name ?? null });
		}
	}
	return { clients: [...clients.values()], projects: [...projects.values()], conflictingNames };
}

export function createClockifyAssociations(transaction: Prisma.TransactionClient, accountId: string) {
	const clients = new Map<string, string>();
	const projects = new Map<string, string>();
	return async ({ client, project }: ResolvedClockifyAssociation) => {
		let clientId = client?.mode === 'existing' ? client.id : null;
		let projectId = project?.mode === 'existing' ? project.id : null;
		if (client?.mode === 'create') {
			const key = catalogNameKey(client.name);
			clientId = clients.get(key) ?? null;
			if (!clientId) {
				clientId = randomUUID();
				await transaction.client.create({ data: { id: clientId, accountId, name: client.name } });
				clients.set(key, clientId);
			}
		}
		if (project?.mode === 'create') {
			const key = projectKey(clientId, project.name);
			projectId = projects.get(key) ?? null;
			if (!projectId) {
				projectId = randomUUID();
				await transaction.project.create({ data: { id: projectId, accountId, clientId, name: project.name } });
				projects.set(key, projectId);
			}
		}
		return { projectId, directClientId: projectId === null ? clientId : null };
	};
}
