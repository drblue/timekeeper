import type { ContinueEntryPreview, ContinueTimerBody } from '@timekeeper/contracts';
import { ApiRequestError } from '../api-error.ts';
import { billingDefaults, workAssociation, workRelations } from '../entries/work-settings.ts';
import type { WorkSettings } from '../entries/work-settings.ts';
import type { Prisma } from '../generated/prisma/client.ts';

export async function continueEntryPreview(
	transaction: Prisma.TransactionClient, accountId: string, entryId: string,
): Promise<ContinueEntryPreview> {
	const source = await transaction.entry.findUnique({ where: { id: entryId, accountId }, include: workRelations });
	if (!source) throw new ApiRequestError(404, 'NOT_FOUND', 'Time entry was not found.');
	const { rateOrePerHour } = await billingDefaults(transaction, accountId, source.projectId, source.directClientId);
	return {
		entryId: source.id, revision: source.revision, description: source.description, billable: source.billable,
		...workAssociation(source), assignedRateOrePerHour: source.assignedRateOrePerHour?.toString() ?? null,
		currentDefaultRateOrePerHour: rateOrePerHour?.toString() ?? null,
	};
}

export async function resolveContinuation(
	transaction: Prisma.TransactionClient, accountId: string, input: ContinueTimerBody,
): Promise<WorkSettings> {
	const preview = await continueEntryPreview(transaction, accountId, input.entryId);
	if (preview.revision !== input.entryRevision || preview.currentDefaultRateOrePerHour !== input.expectedDefaultRateOrePerHour) {
		throw new ApiRequestError(409, 'CONTINUE_PREVIEW_CHANGED', 'The saved entry or its default rate changed. Review the work before continuing.');
	}
	const { description, projectId, directClientId, billable } = preview;
	const selectedRate = input.rateChoice === 'saved' ? preview.assignedRateOrePerHour : preview.currentDefaultRateOrePerHour;
	return { description, projectId, directClientId, billable, assignedRateOrePerHour: selectedRate === null ? null : BigInt(selectedRate) };
}
