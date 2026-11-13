import { maxEntryDescriptionLength } from '@timekeeper/contracts';
import { ApiRequestError } from '../api-error.ts';
import { parseHourlyRateOre } from '../billing.ts';
import { activeProjectWhere, effectiveProjectHourlyRate } from '../catalog/project.ts';
import type { Prisma } from '../generated/prisma/client.ts';

export interface WorkSettings {
	description: string;
	projectId: string | null;
	directClientId: string | null;
	billable: boolean;
	assignedRateOrePerHour: bigint | null;
}

interface WorkSettingsInput {
	description?: string;
	projectId: string | null;
	directClientId: string | null;
	rateOverrideOrePerHour: string | null;
	billable?: boolean;
}

const clientName = { select: { id: true, name: true } } as const;
export const workRelations = {
	project: { select: { name: true, client: clientName } },
	directClient: clientName,
} as const;

type WorkAssociation = Pick<Prisma.RunningTimerGetPayload<{ include: typeof workRelations }>, 'project' | 'directClient' | 'projectId' | 'directClientId'>;

export function workAssociation(record: WorkAssociation) {
	const client = record.project?.client ?? record.directClient;
	return {
		projectId: record.projectId,
		directClientId: record.directClientId,
		clientId: client?.id ?? null,
		projectName: record.project?.name ?? null,
		clientName: client?.name ?? null,
	};
}

export function workDescription(input: string, allowEmpty = false): string {
	const description = input.trim();
	if ((!allowEmpty && !description) || [...description].length > maxEntryDescriptionLength) {
		throw new ApiRequestError(422, 'INVALID_DESCRIPTION', 'Enter a description for the work.', 'description');
	}
	return description;
}

async function billingDefaults(
	transaction: Prisma.TransactionClient, accountId: string, projectId: string | null, directClientId: string | null,
): Promise<{ billable: boolean; rateOrePerHour: bigint | null }> {
	if (projectId !== null) {
		const project = await transaction.project.findUnique({
			where: { id: projectId, ...activeProjectWhere(accountId) },
			select: {
				defaultBillable: true,
				rateOverrideOrePerHour: true,
				client: { select: { defaultRateOrePerHour: true } },
			},
		});
		if (!project) {
			throw new ApiRequestError(422, 'INVALID_PROJECT', 'Choose an active project.', 'projectId');
		}
		return { billable: project.defaultBillable, rateOrePerHour: effectiveProjectHourlyRate(project) };
	}
	if (directClientId !== null) {
		const client = await transaction.client.findUnique({
			where: { id: directClientId, accountId, archivedAt: null },
			select: { defaultRateOrePerHour: true },
		});
		if (!client) {
			throw new ApiRequestError(422, 'INVALID_CLIENT', 'Choose an active client.', 'directClientId');
		}
		return { billable: true, rateOrePerHour: client.defaultRateOrePerHour };
	}
	return { billable: false, rateOrePerHour: null };
}

export async function resolveWorkSettings(
	transaction: Prisma.TransactionClient, accountId: string, input: WorkSettingsInput, allowEmptyDescription = false,
): Promise<WorkSettings> {
	const { projectId, directClientId } = input;
	const description = workDescription(input.description ?? '', allowEmptyDescription);
	if (projectId !== null && directClientId !== null) {
		throw new ApiRequestError(422, 'INVALID_ASSOCIATION', 'Choose a project or a direct client.', 'directClientId');
	}
	const rateOverride = parseHourlyRateOre(input.rateOverrideOrePerHour, 'rateOverrideOrePerHour');
	const defaults = await billingDefaults(transaction, accountId, projectId, directClientId);
	return {
		description, projectId, directClientId,
		billable: input.billable ?? defaults.billable,
		assignedRateOrePerHour: rateOverride ?? defaults.rateOrePerHour,
	};
}
