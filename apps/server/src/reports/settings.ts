import { randomUUID } from 'node:crypto';
import { maxReportBusinessNameLength, reportLogoPath } from '@timekeeper/contracts';
import type { ReportSettingsBody, ReportSettingsResponse } from '@timekeeper/contracts';
import { writeForAccount } from '../account-write.ts';
import { ApiRequestError } from '../api-error.ts';
import type { Prisma, PrismaClient, ReportSettings } from '../generated/prisma/client.ts';
import { decodeReportLogo } from './logo.ts';

const settingsFields = { businessName: true, logoId: true, logoWidth: true, logoHeight: true } as const;
type SettingsFields = Pick<ReportSettings, keyof typeof settingsFields>;

function settingsResponse(settings: SettingsFields | null): ReportSettingsResponse {
	const logo = settings?.logoId && settings.logoWidth && settings.logoHeight
		? { id: settings.logoId, url: `${reportLogoPath}/${settings.logoId}`, width: settings.logoWidth, height: settings.logoHeight }
		: null;
	return { businessName: settings?.businessName ?? null, logo };
}

export async function captureReportBranding(transaction: Prisma.TransactionClient, accountId: string) {
	const settings = await transaction.reportSettings.findUnique({ where: { accountId }, select: { ...settingsFields, logoBytes: true } });
	return { branding: settingsResponse(settings), logoPngBase64: settings?.logoBytes ? Buffer.from(settings.logoBytes).toString('base64') : null };
}

export function createReportSettings(database: PrismaClient) {
	function save(accountId: string, values: Omit<Prisma.ReportSettingsUncheckedCreateInput, 'accountId'>, expectedLogoId?: string | null) {
		return writeForAccount(database, accountId, async (transaction) => {
			if (expectedLogoId !== undefined) {
				const current = await transaction.reportSettings.findUnique({ where: { accountId }, select: { logoId: true } });
				if ((current?.logoId ?? null) !== expectedLogoId) {
					throw new ApiRequestError(409, 'REPORT_LOGO_CHANGED', 'The report logo changed. Reload the settings and try again.');
				}
			}
			return settingsResponse(await transaction.reportSettings.upsert({
				where: { accountId }, create: { accountId, ...values }, update: values, select: settingsFields,
			}));
		});
	}
	return {
		async get(accountId: string) {
			return settingsResponse(await database.reportSettings.findUnique({ where: { accountId }, select: settingsFields }));
		},
		setBusinessName(accountId: string, input: ReportSettingsBody) {
			const businessName = input.businessName?.trim() || null;
			if (businessName && [...businessName].length > maxReportBusinessNameLength) {
				throw new ApiRequestError(422, 'INVALID_BUSINESS_NAME', 'Enter a shorter business name.', 'businessName');
			}
			return save(accountId, { businessName });
		},
		uploadLogo(accountId: string, input: Buffer, expectedLogoId: string | null) {
			const { width, height, bytes } = decodeReportLogo(input);
			return save(accountId, { logoId: randomUUID(), logoWidth: width, logoHeight: height, logoBytes: Uint8Array.from(bytes) }, expectedLogoId);
		},
		removeLogo(accountId: string, expectedLogoId: string | null) {
			return save(accountId, { logoId: null, logoWidth: null, logoHeight: null, logoBytes: null }, expectedLogoId);
		},
		async getLogo(accountId: string, id: string) {
			const settings = await database.reportSettings.findUnique({ where: { accountId, logoId: id }, select: { logoBytes: true } });
			if (!settings?.logoBytes) throw new ApiRequestError(404, 'NOT_FOUND', 'Report logo was not found.');
			return Buffer.from(settings.logoBytes);
		},
	};
}
