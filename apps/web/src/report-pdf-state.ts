import type { ReportPdfBody, ReportPreviewResponse } from '@timekeeper/contracts';

export interface PdfSelection {
	body: ReportPdfBody;
	clientName: string | null;
	projectName: string | null;
}

export interface TrackedReportPdf {
	id: string;
	selection: PdfSelection;
}

const storageKey = 'timekeeper.report-pdf';

export function pdfSelection(report: ReportPreviewResponse): PdfSelection {
	const { scope, showMoney, language, includeDetails } = report;
	return {
		body: {
			preset: 'custom', from: scope.from, to: scope.to, invoice: scope.invoice, billability: scope.billability,
			clientId: scope.clientId ?? undefined, projectId: scope.projectId ?? undefined,
			description: scope.description || undefined, invoiceNumber: scope.invoiceNumber || undefined,
			showMoney: showMoney ? 'true' : 'false', language, includeDetails: includeDetails ? 'true' : 'false',
		},
		clientName: scope.clientName,
		projectName: scope.projectName,
	};
}

export function readReportPdf(account: string): TrackedReportPdf | null {
	try {
		const raw = sessionStorage.getItem(storageKey);
		if (!raw) return null;
		const { account: owner, tracked } = JSON.parse(raw);
		if (owner !== account || typeof tracked?.id !== 'string' ||
			!/^[\da-f-]{36}$/i.test(tracked.id) || !tracked.selection?.body) return null;
		return tracked;
	} catch {
		return null;
	}
}

export function writeReportPdf(account: string, tracked: TrackedReportPdf | null) {
	try {
		if (tracked) {
			sessionStorage.setItem(storageKey, JSON.stringify({ account, tracked }));
		} else if (readReportPdf(account)) {
			sessionStorage.removeItem(storageKey);
		}
	} catch {
		// The job can still be tracked for the current visit.
	}
}
