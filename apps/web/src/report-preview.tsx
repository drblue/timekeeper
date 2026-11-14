import { useQuery } from '@tanstack/react-query';
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router';
import { parseReportPreviewResponse, reportPreviewPath } from '@timekeeper/contracts';
import type { ReportPreviewResponse } from '@timekeeper/contracts';
import { useId, useLayoutEffect, useRef, useState } from 'react';
import { ApiRequestError, readApi } from './api';
import { useSession } from './auth';
import { formatDuration } from './entry-display';
import { formatSek } from './money';
import { DailyReportChart, ProjectReportChart } from './report-charts';
import { ReportPdf } from './report-pdf';
import { pdfSelection } from './report-pdf-state';
import { ReportLogo } from './report-logo';
import { reportIdentityLabels } from './report-labels';
import { reportText } from './report-language';
import type { ReportLanguage } from './report-language';
import { reportBackSearch, reportFilters } from './report-search';
import { WorkListFilters } from './work-list-filters';
import { workListQueryString } from './work-list-search';
import type { WorkListSearch } from './work-list-search';

const reportRoute = getRouteApi('/protected/reports/preview');

function DescriptionSummary({ summaries, showMoney, language }: Pick<ReportPreviewResponse, 'summaries' | 'showMoney' | 'language'>) {
	const copy = reportText[language];
	const heading = useId();
	const scopeLabel = reportIdentityLabels(summaries,
		(row) => (row.clientName ?? copy.noClient) + ' · ' + (row.projectName ?? copy.noProject),
		(row) => row.projectId ?? row.clientId ?? '', copy.unassigned);
	return (
		<section className="panel report-section" aria-labelledby={heading}>
			<h2 id={heading}>{copy.descriptionSummary}</h2>
			{summaries.length ? (
				<table className="report-table report-summary-table">
					<thead><tr><th scope="col">{copy.work}</th><th scope="col">{copy.duration}</th>
						{showMoney ? <th scope="col">{copy.amount}</th> : null}
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
			) : <p className="catalog-empty">{copy.noMatching}</p>}
		</section>
	);
}

const detailPageSize = 25;

function ReportAppendix({ rows, showMoney, language }: {
	rows: NonNullable<ReportPreviewResponse['details']>;
	showMoney: boolean;
	language: ReportLanguage;
}) {
	const id = useId();
	const heading = useRef<HTMLHeadingElement>(null);
	const [page, setPage] = useState(0);
	const totalPages = Math.max(1, Math.ceil(rows.length / detailPageSize));
	const currentPage = Math.min(page, totalPages - 1);
	const visible = rows.slice(currentPage * detailPageSize, (currentPage + 1) * detailPageSize);
	const copy = reportText[language];
	const scopeLabel = reportIdentityLabels(rows,
		(row) => (row.clientName ?? copy.noClient) + ' · ' + (row.projectName ?? copy.noProject),
		(row) => row.projectId ?? row.clientId ?? '', copy.unassigned);

	function changePage(next: number) {
		setPage(next);
		heading.current?.focus();
	}

	return (
		<section className="panel report-section" aria-labelledby={id}>
			<h2 id={id} tabIndex={-1} ref={heading}>{copy.appendix}</h2>
			{rows.length ? (
				<table className="report-table report-summary-table">
					<thead><tr><th scope="col">{copy.work}</th><th scope="col">{copy.duration}</th>
						{showMoney ? <th scope="col">{copy.amount}</th> : null}
					</tr></thead>
					<tbody>
						{visible.map((row) => (
							<tr key={row.entryId + ':' + row.date}>
								<th scope="row">
									<time className="field-hint" dateTime={row.date}>{row.date}</time>
									{row.description}
									<span className="field-hint">{scopeLabel(row)}</span>
								</th>
								<td>{formatDuration(row.seconds)}</td>
								{showMoney ? (
									<td>{formatSek(row.amountOre)}
										{row.hourlyRateOre !== null ? <span className="field-hint">{formatSek(row.hourlyRateOre)}/h</span> : null}
									</td>
								) : null}
							</tr>
						))}
					</tbody>
				</table>
			) : <p className="catalog-empty">{copy.noMatching}</p>}
			{totalPages > 1 ? (
				<nav className="work-list-pagination" aria-label={copy.appendixPage}>
					<button type="button" disabled={currentPage <= 0} onClick={() => changePage(currentPage - 1)}>{copy.previous}</button>
					<p className="field-hint" role="status">{copy.page(currentPage + 1, totalPages)}</p>
					<button type="button" disabled={currentPage >= totalPages - 1} onClick={() => changePage(currentPage + 1)}>{copy.next}</button>
				</nav>
			) : null}
		</section>
	);
}

export function ReportPreview() {
	const location = reportRoute.useSearch();
	const navigate = useNavigate({ from: '/reports/preview' });
	const { refresh, session } = useSession();
	const heading = useRef<HTMLHeadingElement>(null);
	const { showMoney, language, includeDetails, back, ...search } = location;
	const filters = workListQueryString(search);
	const queryString = [filters, showMoney ? 'showMoney=true' : '', language ? 'language=' + language : '',
		includeDetails ? 'includeDetails=true' : ''].filter(Boolean).join('&');
	const report = useQuery({
		queryKey: [reportPreviewPath, queryString],
		queryFn: ({ signal }) => readApi(queryString ? reportPreviewPath + '?' + queryString : reportPreviewPath,
			parseReportPreviewResponse, AbortSignal.any([signal, AbortSignal.timeout(10_000)]), refresh),
		retry: false,
		networkMode: 'always',
	});
	const data = report.data;
	const copy = reportText[data?.language ?? language ?? 'en'];

	useLayoutEffect(() => {
		heading.current?.focus();
	}, []);

	function apply(filters: WorkListSearch) {
		void navigate({ search: { ...reportFilters(filters), showMoney, language, includeDetails, back }, resetScroll: false });
	}

	return (
		<section className="entry-page report-page" aria-labelledby="report-heading">
			<div><Link to="/entries" search={reportBackSearch(back)} state={{ reportPreviewReturned: true }}>Back to time entries</Link></div>
			<h1 className="entry-heading" id="report-heading" tabIndex={-1} ref={heading}>Report preview</h1>
			<WorkListFilters search={search} range={data?.scope} onApply={apply} showSort={false} />
			<section className="panel report-section" aria-labelledby="report-options-heading">
				<div className="catalog-toolbar">
					<h2 id="report-options-heading">Report options</h2>
					<Link to="/settings/report" search={location}>Report branding</Link>
				</div>
				<div className="report-options">
					<div className="field report-month-field">
						<label htmlFor="report-language">Report language</label>
						<select id="report-language" value={language ?? 'en'} onChange={(event) => {
							void navigate({ search: { ...location, language: event.target.value === 'sv' ? 'sv' : undefined }, resetScroll: false });
						}}>
							<option value="en">English</option>
							<option value="sv" lang="sv">Svenska</option>
						</select>
					</div>
					<label className="catalog-checkbox">
						<input type="checkbox" checked={showMoney === 'true'} onChange={(event) => {
							void navigate({ search: { ...location, showMoney: event.target.checked ? 'true' : undefined }, resetScroll: false });
						}} />
						Show rates and billable amounts
					</label>
					<label className="catalog-checkbox">
						<input type="checkbox" checked={includeDetails === 'true'} onChange={(event) => {
							void navigate({ search: { ...location, includeDetails: event.target.checked ? 'true' : undefined }, resetScroll: false });
						}} />
						Include detailed entries
					</label>
				</div>
			</section>
			<ReportPdf key={session.account?.email} account={session.account?.email ?? ''}
				selection={data && !report.isFetching && !report.isError && !data.incompatibleSelection ? pdfSelection(data) : undefined} />
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
				<div className="report-content" lang={data.language}>
					<header className="report-identity">
						<div>
							<h2>{copy.title}</h2>
							{data.branding.businessName ? <p>{data.branding.businessName}</p> : null}
							<p className="field-hint"><time dateTime={data.scope.from}>{data.scope.from}</time> – <time dateTime={data.scope.to}>{data.scope.to}</time></p>
						</div>
						{data.branding.logo ? <ReportLogo key={data.branding.logo.url} url={data.branding.logo.url} alt={data.branding.businessName ? '' : copy.logo}
							refresh={() => {
								heading.current?.focus({ preventScroll: true });
								return report.refetch();
							}} message={copy.logoUnavailable} retryLabel={copy.refreshLogo} /> : null}
					</header>
					<div className="work-list-totals">
						<h2>{copy.completed}</h2>
						<dl aria-label={copy.totals}>
							<div><dt>{copy.duration}</dt><dd>{formatDuration(data.totalSeconds)}</dd></div>
							{data.showMoney ? <div><dt>{copy.amount}</dt><dd>{formatSek(data.totalAmountOre)}</dd></div> : null}
						</dl>
					</div>
					{data.incompatibleSelection ? (
						<p className="feedback warning" role="status">{copy.incompatible}</p>
					) : (
						<>
							<DailyReportChart days={data.days} language={data.language} />
							<ProjectReportChart projects={data.projectShares} totalSeconds={data.totalSeconds} language={data.language} />
							<DescriptionSummary summaries={data.summaries} showMoney={data.showMoney} language={data.language} />
							{data.includeDetails ? <ReportAppendix key={queryString} rows={data.details ?? []} showMoney={data.showMoney} language={data.language} /> : null}
						</>
					)}
				</div>
			) : <p role="status">Loading report…</p>}
		</section>
	);
}
