import { useQuery } from '@tanstack/react-query';
import { getRouteApi, Link } from '@tanstack/react-router';
import { entriesCsvExportPath, parseClientListResponse, parseProjectListResponse, portableExportPath, stockholmDateRange } from '@timekeeper/contracts';
import { useLayoutEffect, useRef, useState } from 'react';
import { useSession } from './auth';
import { catalogKey, catalogPaths, readCatalog } from './catalog';
import { billabilityChoices, effectiveWorkListSearch, invoiceChoices, workListQueryString, workSortChoices } from './work-list-search';

const exportsRoute = getRouteApi('/protected/exports');

export function Exports() {
	const location = exportsRoute.useSearch();
	const { refresh } = useSession();
	const heading = useRef<HTMLHeadingElement>(null);
	const [downloadRequested, setDownloadRequested] = useState<'csv' | 'archive'>();
	const { page: _page, ...filters } = effectiveWorkListSearch(location);
	const preset = filters.preset ?? 'this-week';
	const range = preset === 'custom' && filters.from && filters.to
		? { from: filters.from, to: filters.to }
		: stockholmDateRange(preset === 'custom' ? 'this-week' : preset, new Date().toISOString());
	const query = workListQueryString({ ...filters, preset: 'custom', ...range });
	const clients = useQuery({
		queryKey: [...catalogKey, 'client'],
		queryFn: ({ signal }) => readCatalog(catalogPaths.client, parseClientListResponse, signal, refresh),
		enabled: !!filters.clientId,
		retry: false,
	});
	const projects = useQuery({
		queryKey: [...catalogKey, 'project'],
		queryFn: ({ signal }) => readCatalog(catalogPaths.project, parseProjectListResponse, signal, refresh),
		enabled: !!filters.projectId,
		retry: false,
	});
	const active = [
		filters.clientId ? clients.data?.find((item) => item.id === filters.clientId)?.name ?? 'Selected client' : undefined,
		filters.projectId ? projects.data?.find((item) => item.id === filters.projectId)?.name ?? 'Selected project' : undefined,
		filters.invoice && invoiceChoices[filters.invoice],
		filters.billability && billabilityChoices[filters.billability],
		filters.description && `Description “${filters.description}”`,
		filters.invoiceNumber && `Invoice number “${filters.invoiceNumber}”`,
	].filter(Boolean);

	useLayoutEffect(() => heading.current?.focus(), []);

	return (
		<section className="entry-page" aria-labelledby="exports-heading">
			<div><Link to="/entries" search={location} state={{ exportsReturned: true }}>Back to time entries</Link></div>
			<h1 id="exports-heading" className="entry-heading" ref={heading} tabIndex={-1}>Exports</h1>
			<section className="panel report-section" aria-labelledby="csv-export-heading">
				<h2 id="csv-export-heading">Time entries CSV</h2>
				<p>Download completed time entries across all matching pages. For work spanning midnight, the CSV includes the portions inside the date range.</p>
				<dl className="entry-invoice-values">
					<div><dt>Work dates</dt><dd><time dateTime={range.from}>{range.from}</time> to <time dateTime={range.to}>{range.to}</time></dd></div>
					<div><dt>Sort</dt><dd>{workSortChoices[filters.sort ?? 'newest']}</dd></div>
				</dl>
				{active.length ? <p className="field-hint work-list-active">Filters: {active.join(' · ')}</p> : null}
				<div className="form-actions">
					<a className="action-link" href={entriesCsvExportPath + '?' + query} onClick={() => setDownloadRequested('csv')}>Download CSV</a>
					<Link to="/entries" search={location} state={{ exportsReturned: true }}>Change filters in Entries</Link>
				</div>
			</section>
			<section className="panel report-section" aria-labelledby="portable-export-heading">
				<h2 id="portable-export-heading">Portable archive</h2>
				<p>Download a compressed, versioned copy of all your work, clients, projects, settings, assets, and history, including Clockify import records.</p>
				<p className="field-hint">The archive excludes passwords and session secrets. Administrators use protected backups to restore the application and its accounts.</p>
				<div className="form-actions">
					<a className="action-link" href={portableExportPath} onClick={() => setDownloadRequested('archive')}>Download portable archive</a>
				</div>
			</section>
			{downloadRequested ? <p className="field-hint" role="status">
				Check your browser’s downloads for the {downloadRequested === 'csv' ? 'CSV' : 'portable archive'}.
			</p> : null}
			<p className="field-hint">If a download fails, return here and try again. For a large CSV, shorten the date range in Entries.</p>
		</section>
	);
}
