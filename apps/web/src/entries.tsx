import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi, Link } from '@tanstack/react-router';
import { entriesPath, parseDurationEntryListResponse, parseDurationEntryResponse } from '@timekeeper/contracts';
import type { DurationEntryResponse } from '@timekeeper/contracts';
import { useRef, useState } from 'react';
import { ApiRequestError, readApi } from './api';
import { useSession } from './auth';
import { EntryEditor } from './entry-editor';
import { formatSek } from './money';

const entriesKey = ['entries'] as const;
const entryDetailRoute = getRouteApi('/protected/entries/$entryId');

function formatDuration(seconds: number) {
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor(seconds % 3600 / 60);
	const remainder = seconds % 60;
	return [hours ? `${hours} h` : '', minutes ? `${minutes} min` : '', remainder ? `${remainder} s` : '']
		.filter(Boolean)
		.join(' ');
}

function EntrySummary({ entry }: { entry: DurationEntryResponse }) {
	const association = [entry.projectName, entry.clientName].filter(Boolean).join(' · ');
	return (
		<article className="panel entry-summary">
			<h2><Link to="/entries/$entryId" params={{ entryId: entry.id }}>{entry.description}</Link></h2>
			<p className="entry-summary-values">
				<time dateTime={entry.localDate}>{entry.localDate}</time>
				<span>{formatDuration(entry.durationSeconds)}</span>
				<span>{formatSek(entry.billableAmountOre)}</span>
			</p>
			{association ? <p>{association}</p> : null}
		</article>
	);
}

export function Entries() {
	const { refresh } = useSession();
	const queryClient = useQueryClient();
	const entries = useQuery({
		queryKey: entriesKey,
		queryFn: ({ signal }) => readApi(entriesPath, parseDurationEntryListResponse, signal, refresh),
		retry: false,
		networkMode: 'always',
	});
	const [editing, setEditing] = useState(false);
	const [savedId, setSavedId] = useState<string | null>(null);
	const editorTrigger = useRef<HTMLButtonElement>(null);

	function closeEditor() {
		setEditing(false);
		requestAnimationFrame(() => editorTrigger.current?.focus());
	}

	function saved(entry: DurationEntryResponse) {
		setSavedId(entry.id);
		closeEditor();
		void queryClient.invalidateQueries({ queryKey: entriesKey });
	}

	return (
		<section className="entry-page" aria-labelledby="entries-heading">
			<div className="catalog-toolbar">
				<h1 id="entries-heading">Time entries</h1>
				<button
					type="button"
					className="primary"
					ref={editorTrigger}
					onClick={() => { setSavedId(null); setEditing(true); }}
					disabled={editing}
				>
					New time entry
				</button>
			</div>
			{editing ? <EntryEditor onClose={closeEditor} onSaved={saved} /> : null}
			{savedId ? (
				<p className="feedback" role="status">
					Time entry saved. <Link to="/entries/$entryId" params={{ entryId: savedId }}>View entry</Link>
				</p>
			) : null}
			{entries.isError ? (
				<div className="feedback error catalog-load-error">
					<p role="alert">Could not load time entries. Check your connection and try again.</p>
					<button type="button" onClick={() => void entries.refetch()} disabled={entries.isFetching}>Try again</button>
				</div>
			) : null}
			{entries.data?.length ? (
				<ul className="entry-list">
					{entries.data.map((entry) => <li key={entry.id}><EntrySummary entry={entry} /></li>)}
				</ul>
			) : entries.isPending ? (
				<p role="status">Loading time entries…</p>
			) : entries.data ? <p className="catalog-empty">No time entries yet.</p> : null}
		</section>
	);
}

export function EntryDetail() {
	const { entryId } = entryDetailRoute.useParams();
	const { refresh } = useSession();
	const entry = useQuery({
		queryKey: [...entriesKey, entryId],
		queryFn: ({ signal }) => readApi(`${entriesPath}/${encodeURIComponent(entryId)}`, parseDurationEntryResponse, signal, refresh),
		retry: false,
		networkMode: 'always',
	});
	const missing = entry.error instanceof ApiRequestError && entry.error.response.status === 404;
	const data = entry.data;
	return (
		<section className="entry-page" aria-labelledby="entry-heading">
			<div><Link to="/entries">Back to time entries</Link></div>
			<h1 className="entry-heading" id="entry-heading">{data?.description ?? 'Time entry'}</h1>
			{entry.isError ? (
				<div className="feedback error catalog-load-error">
					<p role="alert">{missing ? 'This time entry is unavailable.' : 'Could not load this time entry. Check your connection and try again.'}</p>
					{missing ? null : <button type="button" onClick={() => void entry.refetch()} disabled={entry.isFetching}>Try again</button>}
				</div>
			) : data ? (
				<dl className="panel entry-details">
					<div><dt>Work date</dt><dd><time dateTime={data.localDate}>{data.localDate}</time></dd></div>
					<div><dt>Duration</dt><dd>{formatDuration(data.durationSeconds)}</dd></div>
					<div><dt>Project</dt><dd>{data.projectName ?? 'None'}</dd></div>
					<div><dt>Client</dt><dd>{data.clientName ?? 'None'}</dd></div>
					<div><dt>Billability</dt><dd>{data.billable ? 'Billable' : 'Non-billable'}</dd></div>
					<div><dt>Effective hourly rate</dt><dd>{data.assignedRateOrePerHour === null ? 'No rate' : `${formatSek(data.assignedRateOrePerHour)}/hour`}</dd></div>
					<div><dt>Billable amount</dt><dd>{formatSek(data.billableAmountOre)}</dd></div>
				</dl>
			) : <p role="status">Loading time entry…</p>}
		</section>
	);
}
