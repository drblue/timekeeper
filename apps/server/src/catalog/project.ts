import type { Prisma } from '../generated/prisma/client.ts';

export function activeProjectWhere(accountId: string) {
	return {
		accountId,
		archivedAt: null,
		OR: [{ clientId: null }, { client: { is: { accountId, archivedAt: null } } }],
	} satisfies Prisma.ProjectWhereInput;
}

export function effectiveProjectHourlyRate(project: {
	rateOverrideOrePerHour: bigint | null;
	client: { defaultRateOrePerHour: bigint | null } | null;
}): bigint | null {
	return project.rateOverrideOrePerHour ?? project.client?.defaultRateOrePerHour ?? null;
}
