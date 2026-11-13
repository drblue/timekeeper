import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi, Link, useLocation, useNavigate } from '@tanstack/react-router';
import { entriesPath, parseEntryResponse, parseWorkListResponse, workListPath } from '@timekeeper/contracts';
import type { EntryResponse, WorkListRange } from '@timekeeper/contracts';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { ApiRequestError, readApi } from './api';
import { useSession } from './auth';
import { EntryCompletion } from './entry-completion';
import { EntryDelete } from './entry-delete';
import { EntryContinue } from './entry-continue';
import { entriesKey } from './entry-query';
import { formatDuration, StockholmTime } from './entry-display';
import { EntryHistory } from './entry-history';
import { EntryEditor } from './entry-editor';
import { WorkListFilters } from './work-list-filters';
import { effectiveWorkListSearch, unpinWorkListSearch, workListQueryString } from './work-list-search';
import type { WorkListLocation } from './work-list-search';
import { formatSek } from './money';

const workListRoute = getRouteApi('/protected/entries');
const entryDetailRoute = getRouteApi('/protected/entries/$entryId');

const dayHeading = new Intl.DateTimeFormat('en-GB', {
	timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'short',
});

interface RowPosition {
	returnRow: string;
	returnOffset: number;
	returnFrom?: string;
	returnTo?: string;
}

function EntrySummary({ entry, seconds, amountOre, day, search, range, onOpen }: {
	entry: EntryResponse;
	seconds: number;
	amountOre: string | null;
	day: string;
	search: WorkListLocation;
	range: WorkListRange;
	onOpen: (position: RowPosition) => void;
}) {
	const association = [entry.projectName, entry.clientName].filter(Boolean).join(' · ');
	const row = useRef<HTMLElement>(null);
	const id = entry.id + ':' + (entry.completion === 'incomplete' ? 'incomplete' : day);
	const portion = seconds !== entry.durationSeconds;
	const detailSearch = { ...search, returnFrom: range.from, returnTo: range.to, returnRow: id, returnOffset: 0 };
	return (
		<article className="entry-summary work-list-row" id={id} ref={row}>
			<div className="work-list-row-main">
				<h3><Link to="/entries/$entryId" params={{ entryId: entry.id }} search={detailSearch}
					onClick={(event) => {
						if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
						onOpen({ returnRow: id, returnOffset: Math.round(row.current?.getBoundingClientRect().top ?? 0),
							returnFrom: range.from, returnTo: range.to });
					}}>
					{entry.description || 'Untitled time entry'}
				</Link></h3>
				{association ? <p>{association}</p> : null}
				{entry.invoicedAt ? <p className="field-hint">Invoiced{entry.invoiceNumber ? ' · ' + entry.invoiceNumber : ''}</p> : null}
				{entry.kind === 'timed' ? (
					<p className="field-hint">
						{portion ? 'Part of timed entry · ' : ''}
						<StockholmTime instant={entry.startAt} /> to <StockholmTime instant={entry.endAt} />
					</p>
				) : null}
			</div>
			<p className="entry-summary-values work-list-row-values">
				<span>{formatDuration(seconds)}</span>
				<span>{amountOre === null ? 'Incomplete' : formatSek(amountOre)}</span>
			</p>
		</article>
	);
}

// The current position is local to the list view and used for the explicit link back as well as browser Back.
let workListPosition: { key: string; row: RowPosition } | undefined;

export function Entries() {
	const { refresh, session } = useSession();
	const queryClient = useQueryClient();
	const navigate = useNavigate({ from: '/entries' });
	const location = workListRoute.useSearch();
	const movedToTrash = useLocation({ select: ({ state }) => state.entryMovedToTrash === true });
	const search = effectiveWorkListSearch(location);
	const filterKey = workListQueryString(search);
	const positionKey = (session.account?.email ?? '') + '\n' + workListQueryString(unpinWorkListSearch(location));
	const entries = useQuery({
		queryKey: [...entriesKey, 'list', filterKey],
		queryFn: ({ signal }) => readApi(filterKey ? workListPath + '?' + filterKey : workListPath,
			parseWorkListResponse, AbortSignal.any([signal, AbortSignal.timeout(10_000)]), refresh),
		retry: false,
		networkMode: 'always',
	});
	const [editing, setEditing] = useState(false);
	const [savedId, setSavedId] = useState<string | null>(null);
	const editorTrigger = useRef<HTMLButtonElement>(null);
	const results = useRef<HTMLHeadingElement>(null);
	const heading = useRef<HTMLHeadingElement>(null);
	const restored = useRef<string | null>(null);
	const pageFocus = useRef(false);
	const data = entries.data;

	function closeEditor() {
		setEditing(false);
		requestAnimationFrame(() => editorTrigger.current?.focus());
	}

	function saved(entry: EntryResponse) {
		setSavedId(entry.id);
		closeEditor();
		void queryClient.invalidateQueries({ queryKey: entriesKey });
	}

	function remember(position: RowPosition) {
		workListPosition = { key: positionKey, row: position };
	}

	function apply(next: WorkListLocation, pageChanged = false) {
		workListPosition = undefined;
		pageFocus.current = pageChanged;
		void navigate({ search: next, resetScroll: false });
	}

	useLayoutEffect(() => {
		if (!data || entries.isFetching || entries.isError || restored.current === filterKey) return;
		restored.current = filterKey;
		if (pageFocus.current) {
			pageFocus.current = false;
			results.current?.focus();
			return;
		}
		const remembered = workListPosition?.key === positionKey ? workListPosition.row : undefined;
		workListPosition = undefined;
		const rowId = location.returnRow ?? remembered?.returnRow;
		if (!rowId) {
			if (movedToTrash) heading.current?.focus();
			return;
		}
		const row = document.getElementById(rowId);
		if (!row) {
			results.current?.focus();
			return;
		}
		const offset = remembered?.returnOffset ?? location.returnOffset ?? 0;
		row.querySelector('a')?.focus({ preventScroll: true });
		window.scrollBy(0, row.getBoundingClientRect().top - offset);
	}, [data, entries.isError, entries.isFetching, filterKey, location.returnOffset, location.returnRow, movedToTrash, positionKey]);

	const showPaging = data && data.totalPages > 1;
	return (
		<section className="entry-page" aria-labelledby="entries-heading">
			<div className="catalog-toolbar">
				<h1 id="entries-heading" tabIndex={-1} ref={heading}>Time entries</h1>
				<div className="form-actions">
					<Link className="action-link" to="/entries/trash" search={location}>Trash</Link>
					<button type="button" className="primary" ref={editorTrigger} disabled={editing}
						onClick={() => { setSavedId(null); setEditing(true); }}>New time entry</button>
				</div>
			</div>
			{movedToTrash ? <p className="feedback" role="status">Time entry moved to Trash.</p> : null}
			{editing ? <EntryEditor onClose={closeEditor} onSaved={saved} /> : null}
			{savedId ? (
				<p className="feedback" role="status">
					Time entry saved. <Link to="/entries/$entryId" params={{ entryId: savedId }} search={unpinWorkListSearch(location)}>View entry</Link>
				</p>
			) : null}
			<WorkListFilters search={unpinWorkListSearch(location)} range={data?.range} onApply={apply} />
			{entries.isError ? (
				<div className="feedback error catalog-load-error">
					<p role="alert">Could not load time entries. Check your connection and filters.</p>
					<button type="button" onClick={() => void entries.refetch()} disabled={entries.isFetching}>Try again</button>
				</div>
			) : data ? (
				<div className="work-list-results">
					<div className="work-list-totals">
						<h2 tabIndex={-1} ref={results}>Completed work</h2>
						<dl aria-label="Totals for all matching days">
							<div><dt>Duration</dt><dd>{formatDuration(data.totals.seconds)}</dd></div>
							<div><dt>Billable amount</dt><dd>{formatSek(data.totals.amountOre)}</dd></div>
						</dl>
					</div>
					{data.incompatibleSelection ? (
						<p className="feedback warning" role="status">The selected project does not belong to the selected client. Change one of the filters.</p>
					) : data.groups.length ? (
						data.groups.map((group) => (
							<section key={group.localDate} className="panel work-list-day" aria-labelledby={'day-' + group.localDate}>
								<h3 id={'day-' + group.localDate}><time dateTime={group.localDate}>{dayHeading.format(new Date(group.localDate + 'T00:00:00Z'))}</time></h3>
								<ul className="entry-list">
									{group.rows.map(({ entry, seconds, amountOre }) => (
										<li key={entry.id}><EntrySummary entry={entry} seconds={seconds} amountOre={amountOre}
											day={group.localDate} search={location} range={data.range} onOpen={remember} /></li>
									))}
								</ul>
							</section>
						))
					) : <p className="catalog-empty">No completed time entries match these filters.</p>}
					{showPaging ? (
						<nav className="work-list-pagination" aria-label="Time entry pages">
							<button type="button" disabled={data.page <= 1}
								onClick={() => apply({ ...location, page: data.page > 2 ? data.page - 1 : undefined, returnRow: undefined, returnOffset: undefined }, true)}>Previous page</button>
							<p className="field-hint">Page {data.page} of {data.totalPages}</p>
							<button type="button" disabled={data.page >= data.totalPages}
								onClick={() => apply({ ...location, page: data.page + 1, returnRow: undefined, returnOffset: undefined }, true)}>Next page</button>
						</nav>
					) : null}
					{data.incomplete.length ? (
						<section className="panel work-list-day" aria-label="Incomplete work">
							<h3>Incomplete work</h3>
							<p className="field-hint">Excluded from completed totals.</p>
							<ul className="entry-list">
								{data.incomplete.map((entry) => (
									<li key={entry.id}><EntrySummary entry={entry} seconds={entry.durationSeconds} amountOre={null}
										day={entry.localDate} search={location} range={data.range} onOpen={remember} /></li>
								))}
							</ul>
						</section>
					) : null}
				</div>
			) : <p role="status">Loading time entries…</p>}
		</section>
	);
}

export function EntryDetail() {
	const { entryId } = entryDetailRoute.useParams();
	const listSearch = entryDetailRoute.useSearch();
	const navigate = useNavigate({ from: '/entries/$entryId' });
	const { refresh } = useSession();
	const queryClient = useQueryClient();
	const [feedback, setFeedback] = useState<{ id: string; text: string } | null>(null);
	const [editingEntry, setEditingEntry] = useState<EntryResponse | null>(null);
	const heading = useRef<HTMLHeadingElement>(null);
	const focusHeading = useCallback(() => heading.current?.focus(), []);
	const entry = useQuery({
		queryKey: [...entriesKey, entryId],
		queryFn: ({ signal }) => readApi(`${entriesPath}/${encodeURIComponent(entryId)}`, parseEntryResponse, signal, refresh),
		retry: false,
		networkMode: 'always',
	});
	const missing = entry.error instanceof ApiRequestError && entry.error.response.status === 404;
	const data = entry.data;

	function savedEntry(saved: EntryResponse, text: string) {
		queryClient.setQueryData([...entriesKey, entryId], saved);
		setFeedback({ id: saved.id, text });
		setEditingEntry(null);
		focusHeading();
		void queryClient.invalidateQueries({ queryKey: entriesKey });
	}

	function deleted() {
		void queryClient.invalidateQueries({ queryKey: entriesKey, refetchType: 'none' });
		void navigate({
			to: '/entries',
			search: listSearch,
			state: { entryMovedToTrash: true },
			replace: true,
			resetScroll: false,
		});
	}

	return (
		<section className="entry-page" aria-labelledby="entry-heading">
			<div><Link to="/entries" search={listSearch} resetScroll={false}>Back to time entries</Link></div>
			<h1 className="entry-heading" id="entry-heading" ref={heading} tabIndex={-1}>{data?.description || (data ? 'Untitled time entry' : 'Time entry')}</h1>
			{feedback?.id === entryId ? <p className="feedback" role="status">{feedback.text}</p> : null}
			{entry.isError ? (
				<div className="feedback error catalog-load-error">
					<p role="alert">{missing ? 'This time entry is unavailable.' : 'Could not load this time entry. Check your connection and try again.'}</p>
					{missing ? <Link to="/entries/trash" search={listSearch}>Open Trash</Link> : <button type="button" onClick={() => void entry.refetch()} disabled={entry.isFetching}>Try again</button>}
				</div>
			) : null}
			{data && !missing ? (
				<>
					<dl className="panel entry-details">
						{data.kind === 'timed' ? (
							<>
								<div><dt>Start (Stockholm)</dt><dd><StockholmTime instant={data.startAt} /></dd></div>
								<div><dt>End (Stockholm)</dt><dd><StockholmTime instant={data.endAt} /></dd></div>
							</>
						) : <div><dt>Work date</dt><dd><time dateTime={data.localDate}>{data.localDate}</time></dd></div>}
						<div><dt>Duration</dt><dd>{formatDuration(data.durationSeconds)}</dd></div>
						<div><dt>Project</dt><dd>{data.projectName ?? 'None'}</dd></div>
						<div><dt>Client</dt><dd>{data.clientName ?? 'None'}</dd></div>
						<div><dt>Billability</dt><dd>{data.billable ? 'Billable' : 'Non-billable'}</dd></div>
						<div><dt>Effective hourly rate</dt><dd>{data.assignedRateOrePerHour === null ? 'No rate' : `${formatSek(data.assignedRateOrePerHour)}/hour`}</dd></div>
						{data.completion === 'complete' ? (
							<div><dt>Billable amount</dt><dd>{formatSek(data.billableAmountOre)}</dd></div>
						) : (
							<div className="entry-completion"><dt>Status</dt><dd>Incomplete · Excluded from report totals.</dd></div>
						)}
						{data.kind === 'timed' && data.allocations.length > 1 ? (
							<div className="entry-allocation-details">
								<dt>Daily allocation (Stockholm)</dt>
								<dd>
									<ul className="entry-allocation-list">
										{data.allocations.map((allocation) => (
											<li key={allocation.localDate} className="entry-summary-values">
												<time dateTime={allocation.localDate}>{allocation.localDate}</time>
												<span>{formatDuration(allocation.seconds)}</span>
												<span>{formatSek(allocation.amountOre)}</span>
											</li>
										))}
									</ul>
								</dd>
							</div>
						) : null}
					</dl>
					{editingEntry?.id === entryId ? (
						<EntryEditor key={'editor:' + entryId} entry={editingEntry} onClose={() => { setEditingEntry(null); focusHeading(); }}
							onSaved={(saved) => savedEntry(saved, 'Time entry updated.')} />
					) : (
						<>
							{data.invoicedAt ? (
								<p className="feedback warning">This entry is invoiced. Unmark it before editing or moving it to Trash.</p>
							) : data.completion === 'complete' ? (
								<div className="form-actions">
									<button type="button" onClick={() => { setFeedback(null); setEditingEntry(data); }}>Edit entry</button>
								</div>
							) : null}
							<EntryContinue key={'continue:' + entryId} entryId={entryId} onFallbackFocus={focusHeading} />
							{data.completion === 'incomplete' && !data.invoicedAt ? <EntryCompletion key={'completion:' + entryId} entry={data}
								onSaved={(saved) => savedEntry(saved, 'Time entry completed.')} onRefresh={() => void entry.refetch()} /> : null}
							{!data.invoicedAt ? <EntryDelete key={'delete:' + entryId} entry={data} onDeleted={deleted}
								onRefresh={async () => {
									const latest = await entry.refetch();
									return latest.isSuccess ? latest.data : undefined;
								}} /> : null}
						</>
					)}
					<EntryHistory key={'history:' + entryId} entryId={entryId} />
				</>
			) : entry.isPending ? <p role="status">Loading time entry…</p> : null}
		</section>
	);
}
