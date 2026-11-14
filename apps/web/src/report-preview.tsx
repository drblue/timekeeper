import { useQuery } from '@tanstack/react-query';
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router';
import { parseReportPreviewResponse, reportPreviewPath } from '@timekeeper/contracts';
import type { ReportPreviewResponse } from '@timekeeper/contracts';
import { useId, useLayoutEffect, useRef } from 'react';
import { ApiRequestError, readApi } from './api';
import { useSession } from './auth';
import { formatDuration } from './entry-display';
import { formatSek } from './money';
import { DailyReportChart, ProjectReportChart } from './report-charts';
import { reportIdentityLabels } from './report-labels';
import { reportBackSearch, reportFilters } from './report-search';
import { WorkListFilters } from './work-list-filters';
import { workListQueryString } from './work-list-search';
import type { WorkListSearch } from './work-list-search';

const reportRoute = getRouteApi('/protected/reports/preview');

function DescriptionSummary({ summaries, showMoney }: Pick<ReportPreviewResponse, 'summaries' | 'showMoney'>) {
	const heading = useId();
	const scopeLabel = reportIdentityLabels(summaries,
		(row) => (row.clientName ?? 'No client') + ' · ' + (row.projectName ?? 'No project'),
		(row) => row.projectId ?? row.clientId ?? '');
	return (
		<section className="panel report-section" aria-labelledby={heading}>
			<h2 id={heading}>Work by description</h2>
			{summaries.length ? (
				<table className="report-table report-summary-table">
					<thead><tr><th scope="col">Work</th><th scope="col">Duration</th>
						{showMoney ? <th scope="col">Billable amount</th> : null}
					</tr></thead>
					<tbody>
						{summaries.map((row) => (
							<tr key={JSON.stringify([row.clientId, row.projectId, row.description, row.hourlyRateOre])}>
								<th scope="row">
									{row.description}
									<span className="field-hint">{scopeLabel(row)}</span>
								</th>
								<td>{formatDuration(row.seconds)}</td>
								{showMoney ? (
									<td>
										{formatSek(row.amountOre)}
										{row.hourlyRateOre !== null ? <span className="field-hint">{formatSek(row.hourlyRateOre)}/h</span> : null}
									</td>
								) : null}
							</tr>
						))}
					</tbody>
				</table>
			) : <p className="catalog-empty">No completed work matches these filters.</p>}
		</section>
	);
}

export function ReportPreview() {
	const location = reportRoute.useSearch();
	const navigate = useNavigate({ from: '/reports/preview' });
	const { refresh } = useSession();
	const heading = useRef<HTMLHeadingElement>(null);
	const { showMoney, back, ...search } = location;
	const filters = workListQueryString(search);
	const queryString = [filters, showMoney ? 'showMoney=true' : ''].filter(Boolean).join('&');
	const report = useQuery({
		queryKey: [reportPreviewPath, queryString],
		queryFn: ({ signal }) => readApi(queryString ? reportPreviewPath + '?' + queryString : reportPreviewPath,
			parseReportPreviewResponse, AbortSignal.any([signal, AbortSignal.timeout(10_000)]), refresh),
		retry: false,
		networkMode: 'always',
	});
	const data = report.data;

	useLayoutEffect(() => {
		heading.current?.focus();
	}, []);

	function apply(filters: WorkListSearch) {
		void navigate({ search: { ...reportFilters(filters), showMoney, back }, resetScroll: false });
	}

	return (
		<section className="entry-page report-page" aria-labelledby="report-heading">
			<div><Link to="/entries" search={reportBackSearch(back)} state={{ reportPreviewReturned: true }}>Back to time entries</Link></div>
			<h1 className="entry-heading" id="report-heading" tabIndex={-1} ref={heading}>Report preview</h1>
			<WorkListFilters search={search} range={data?.scope} onApply={apply} showSort={false} />
			<label className="catalog-checkbox">
				<input type="checkbox" checked={showMoney === 'true'} onChange={(event) => {
					void navigate({ search: { ...location, showMoney: event.target.checked ? 'true' : undefined }, resetScroll: false });
				}} />
				Show rates and billable amounts
			</label>
			{report.isError ? (
				<div className="feedback error catalog-load-error">
					{report.error instanceof ApiRequestError && report.error.code === 'REPORT_RANGE_TOO_LONG' ? (
						<p role="alert">The date range is too long for a report. Choose a shorter range.</p>
					) : (
						<>
							<p role="alert">Could not load the report. Check your connection and try again.</p>
							<button type="button" onClick={() => void report.refetch()} disabled={report.isFetching}>Try again</button>
						</>
					)}
				</div>
			) : data ? (
				<>
					<div className="work-list-totals">
						<h2>Completed work</h2>
						<dl aria-label="Report totals">
							<div><dt>Duration</dt><dd>{formatDuration(data.totalSeconds)}</dd></div>
							{data.showMoney ? <div><dt>Billable amount</dt><dd>{formatSek(data.totalAmountOre)}</dd></div> : null}
						</dl>
					</div>
					{data.incompatibleSelection ? (
						<p className="feedback warning" role="status">The selected project does not belong to the selected client. Change one of the filters.</p>
					) : (
						<>
							<DailyReportChart days={data.days} />
							<ProjectReportChart projects={data.projectShares} totalSeconds={data.totalSeconds} />
							<DescriptionSummary summaries={data.summaries} showMoney={data.showMoney} />
						</>
					)}
				</>
			) : <p role="status">Loading report…</p>}
		</section>
	);
}
