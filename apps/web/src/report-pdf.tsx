import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
	parseReportJobResponse, reportJobsPath, reportPdfPath,
} from '@timekeeper/contracts';
import type { ReportJobResponse } from '@timekeeper/contracts';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ApiRequestError, readApi, writeApi } from './api';
import { authError, useSession } from './auth';
import { StockholmTime } from './entry-display';
import { readReportPdf, writeReportPdf } from './report-pdf-state';
import type { PdfSelection, TrackedReportPdf } from './report-pdf-state';
import { billabilityChoices, invoiceChoices } from './work-list-search';

const jobLabels: Record<ReportJobResponse['status'], string> = {
	queued: 'PDF queued.',
	running: 'Generating PDF…',
	ready: 'PDF ready to download.',
	failed: 'PDF generation failed.',
	expired: 'The PDF download has expired.',
};

const failureDetails: Record<NonNullable<ReportJobResponse['errorCode']>, string> = {
	REPORT_RENDER_FAILED: 'Try generating the report again.',
	REPORT_TIMEOUT: 'The report took too long. Try again or use a shorter date range.',
	REPORT_OUTPUT_TOO_LARGE: 'The PDF is too large. Use a shorter date range or omit detailed entries.',
};

function selectionLabels(selection: PdfSelection) {
	const { body, clientName, projectName } = selection;
	return [
		body.from + ' to ' + body.to,
		body.language === 'sv' ? 'Swedish' : 'English',
		body.showMoney === 'true' ? 'Rates and amounts' : 'Time only',
		body.includeDetails === 'true' ? 'Detailed entries' : 'Summary only',
		clientName ?? (body.clientId ? 'Selected client' : ''),
		projectName ?? (body.projectId ? 'Selected project' : ''),
		body.invoice && body.invoice !== 'all' ? invoiceChoices[body.invoice] : '',
		body.billability && body.billability !== 'all' ? billabilityChoices[body.billability] : '',
		body.description ? 'Description “' + body.description + '”' : '',
		body.invoiceNumber ? 'Invoice number “' + body.invoiceNumber + '”' : '',
	].filter(Boolean);
}

function creatingError(error: ApiRequestError) {
	switch (error.code) {
		case 'REPORT_QUEUE_FULL': return 'The PDF queue is full. Wait a moment and try again.';
		case 'REPORT_INPUT_TOO_LARGE': return 'This report is too large. Choose a shorter date range or omit detailed entries.';
		case 'REPORT_RANGE_TOO_LONG': return 'The date range is too long. Choose a shorter range.';
		case 'REPORT_INCOMPATIBLE_SELECTION': return 'The selected project does not belong to the selected client. Change one of the filters.';
		default: return 'Could not request a PDF. Check the report filters and try again.';
	}
}

function active(status: ReportJobResponse['status'] | undefined) {
	return status === 'queued' || status === 'running';
}

export function ReportPdf({ account, selection }: { account: string; selection: PdfSelection | undefined }) {
	const { session, refresh } = useSession();
	const queryClient = useQueryClient();
	const [tracked, setTracked] = useState(() => readReportPdf(account));
	const [pending, setPending] = useState<PdfSelection>();
	const [error, setError] = useState<{ message: string; retry?: PdfSelection }>();
	const heading = useRef<HTMLHeadingElement>(null);
	const focusAfter = useRef(false);
	const job = useQuery({
		queryKey: [reportJobsPath, tracked?.id],
		queryFn: ({ signal }) => readApi(reportJobsPath + '/' + encodeURIComponent(tracked!.id),
			parseReportJobResponse, AbortSignal.any([signal, AbortSignal.timeout(10_000)]), refresh),
		enabled: !!tracked,
		retry: false,
		refetchOnReconnect: true,
		refetchInterval: (query) => query.state.status !== 'error' && active(query.state.data?.status) ? 1500 : false,
		networkMode: 'always',
	});
	const saved = job.data;
	const downloadPath = saved && saved.status === 'ready' && saved.downloadUrl === reportJobsPath + '/' + saved.id + '/download'
		? saved.downloadUrl : undefined;
	const unavailable = job.error instanceof ApiRequestError && job.error.response.status === 404;
	const blocked = !!tracked && !unavailable && (job.isError || !saved || active(saved.status));
	const previousScope = pending ?? tracked?.selection;
	const changed = !!selection && !!tracked &&
		JSON.stringify(selection.body) !== JSON.stringify(tracked.selection.body);

	useLayoutEffect(() => {
		if (!focusAfter.current || pending) return;
		focusAfter.current = false;
		heading.current?.focus({ preventScroll: true });
	}, [pending]);

	useEffect(() => {
		if (saved?.status !== 'ready' || !saved.expiresAt) return;
		const remaining = Date.parse(saved.expiresAt) - Date.now();
		// Allow time for server clocks and the exact expiry boundary.
		const timeout = window.setTimeout(() => void job.refetch(), Math.min(2_147_000_000, Math.max(1_000, remaining + 1_000)));
		return () => window.clearTimeout(timeout);
	}, [saved, job.refetch]);

	async function generate(request: PdfSelection) {
		if (pending || blocked) return;
		setPending(request);
		setError(undefined);
		try {
			const response = await writeApi(reportPdfPath, 'POST', session.csrfToken, request.body, {
				signal: AbortSignal.timeout(15_000),
			});
			const created = parseReportJobResponse(await response.json());
			const next: TrackedReportPdf = { id: created.id, selection: request };
			queryClient.setQueryData([reportJobsPath, next.id], created);
			writeReportPdf(account, next);
			setTracked(next);
		} catch (cause) {
			if (cause instanceof ApiRequestError && [401, 403].includes(cause.response.status)) {
				setError({ message: await authError(cause.response, refresh), retry: request });
			} else if (cause instanceof ApiRequestError && cause.response.status < 500) {
				setError({
					message: creatingError(cause),
					retry: cause.code === 'REPORT_QUEUE_FULL' ? request : undefined,
				});
			} else {
				setError({ message: 'Could not confirm the PDF request. It may still be processing. Retry if you need another copy.', retry: request });
			}
		} finally {
			focusAfter.current = true;
			setPending(undefined);
		}
	}

	function checkStatus() {
		heading.current?.focus({ preventScroll: true });
		void job.refetch();
	}

	return (
		<section className="panel report-section report-pdf" aria-labelledby="report-pdf-heading">
			<div className="catalog-toolbar">
				<h2 id="report-pdf-heading" tabIndex={-1} ref={heading}>PDF report</h2>
				<button type="button" className="primary" disabled={!selection || !!pending || blocked}
					onClick={() => { if (selection) void generate(selection); }}>Generate PDF</button>
			</div>
			{pending ? <p role="status">Requesting PDF…</p> : null}
			{error ? (
				<div className="feedback error catalog-load-error">
					<p role="alert">{error.message}</p>
					{error.retry ? (
						<>
							<p className="field-hint">{selectionLabels(error.retry).join(' · ')}</p>
							<button type="button" disabled={!!pending || blocked} onClick={() => {
								if (error.retry) void generate(error.retry);
							}}>Retry PDF request</button>
						</>
					) : null}
				</div>
			) : null}
			{previousScope ? (
				<div className="report-pdf-job">
					<p className="field-hint">{selectionLabels(previousScope).join(' · ')}</p>
					{!pending && changed ? <p className="field-hint">This PDF uses an earlier selection.</p> : null}
					{!pending && job.isError ? (
						<div className="feedback warning catalog-load-error">
							<p role="alert">{unavailable ? 'This PDF is no longer available.' : 'Could not check the PDF status. Check your connection and try again.'}</p>
							{unavailable && tracked ? (
								<button type="button" onClick={() => void generate(tracked.selection)}>Generate this PDF again</button>
							) : <button type="button" disabled={job.isFetching} onClick={checkStatus}>Check PDF status</button>}
						</div>
					) : !pending && saved ? (
						<>
							<p role="status">{jobLabels[saved.status]}</p>
							{saved.errorCode ? <p className="field-hint">{failureDetails[saved.errorCode]}</p> : null}
							{downloadPath ? (
								<div className="form-actions">
									<a className="action-link" href={downloadPath}>Download PDF</a>
									{saved.expiresAt ? <p className="field-hint">Available until <StockholmTime instant={saved.expiresAt} />.</p> : null}
								</div>
							) : null}
							{(saved.status === 'failed' || saved.status === 'expired') && tracked ? (
								<div className="form-actions">
									<button type="button" onClick={() => void generate(tracked.selection)}>Generate this PDF again</button>
								</div>
							) : null}
						</>
					) : !pending && tracked ? <p role="status">Checking PDF status…</p> : null}
				</div>
			) : null}
		</section>
	);
}
