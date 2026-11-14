import { once } from 'node:events';
import { parseReportPreviewResponse, reportIdentityLabels } from '@timekeeper/contracts';
import type { ReportPreviewResponse } from '@timekeeper/contracts';
import { renderPdfmakeReport } from '@timekeeper/report-renderer/pdfmake';
import type { ReportData, ReportLine } from '@timekeeper/report-renderer/report-data';
import { maxReportPdfBytes, maxReportSnapshotBytes } from './job-limits.ts';

// The renderer must leave if the app is interrupted, even when its stdio remains open.
const leave = () => process.exit(1);
process.once('disconnect', leave);

function prepareData(preview: ReportPreviewResponse, logoPngBase64: string | null): ReportData {
	const swedish = preview.language === 'sv';
	const noProject = swedish ? 'Inget projekt' : 'No project';
	const noClient = swedish ? 'Ingen kund' : 'No client';
	const unassigned = swedish ? 'Ej tilldelat' : 'Unassigned';
	const projectLabel = reportIdentityLabels(
		preview.projectShares, (row) => row.projectName ?? noProject, (row) => row.projectId ?? '', unassigned,
	);
	function prepareLines<T extends ReportPreviewResponse['summaries'][number]>(rows: readonly T[]) {
		const groupLabel = reportIdentityLabels(
			rows, (row) => (row.clientName ?? noClient) + '\n' + (row.projectName ?? noProject),
			(row) => row.projectId ?? row.clientId ?? '', unassigned,
		);
		return rows.map((row) => ({
			...row, groupLabel: groupLabel(row),
			hourlyRateOre: row.hourlyRateOre === null ? null : BigInt(row.hourlyRateOre),
			amountOre: BigInt(row.amountOre),
		}) satisfies ReportLine);
	}
	return {
		language: preview.language,
		numberLocale: 'sv-SE',
		ownerName: preview.branding.businessName ?? '',
		logo: logoPngBase64 ? Buffer.from(logoPngBase64, 'base64') : undefined,
		showMoney: preview.showMoney,
		scope: {
			...preview.scope,
			billability: preview.scope.billability === 'non-billable' ? 'nonBillable' : preview.scope.billability,
			invoiceStatus: preview.scope.invoice === 'not-yet-invoiced' ? 'uninvoiced' : preview.scope.invoice,
		},
		totalSeconds: preview.totalSeconds,
		totalAmountOre: BigInt(preview.totalAmountOre),
		days: preview.days,
		projectShares: preview.projectShares.map((row) => ({ ...row, displayName: projectLabel(row) })),
		summaries: prepareLines(preview.summaries),
		details: preview.details ? prepareLines(preview.details) : undefined,
	};
}

try {
	const chunks: Buffer[] = [];
	let length = 0;
	for await (const chunk of process.stdin) {
		length += chunk.length;
		if (length > maxReportSnapshotBytes) throw new Error('Report snapshot exceeds size limit');
		chunks.push(chunk);
	}
	const { version, preview, logoPngBase64 } = JSON.parse(Buffer.concat(chunks, length).toString('utf8'));
	if (version !== 1 || (logoPngBase64 !== null && typeof logoPngBase64 !== 'string')) throw new Error('Invalid report snapshot');
	const data = prepareData(parseReportPreviewResponse(preview), logoPngBase64);
	const pdf = await renderPdfmakeReport(data);
	if (pdf.length > maxReportPdfBytes) {
		process.exitCode = 2;
	} else if (!process.stdout.write(pdf)) {
		await once(process.stdout, 'drain');
	}
} catch {
	process.exitCode = 1;
} finally {
	process.removeListener('disconnect', leave);
	if (process.connected) process.disconnect?.();
}
