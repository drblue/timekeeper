import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi, Link } from '@tanstack/react-router';
import { entryTrashPath, parseEntryResponse, parseEntryTrashResponse } from '@timekeeper/contracts';
import type { EntryResponse, TrashedEntryResponse } from '@timekeeper/contracts';
import { useRef, useState } from 'react';
import { readApi } from './api';
import { useSession } from './auth';
import { formatDuration, StockholmTime } from './entry-display';
import { changeEntryLifecycle, entryLifecycleError } from './entry-lifecycle';
import { entriesKey } from './entry-query';
import { formatSek } from './money';

const trashRoute = getRouteApi('/protected/entries/trash');
const trashKey = [...entriesKey, 'trash'] as const;

export function EntryTrash() {
	const search = trashRoute.useSearch();
	const { session, refresh } = useSession();
	const queryClient = useQueryClient();
	const heading = useRef<HTMLHeadingElement>(null);
	const [pending, setPending] = useState<string | null>(null);
	const [error, setError] = useState('');
	const [restored, setRestored] = useState<EntryResponse | null>(null);
	const trash = useQuery({
		queryKey: trashKey,
		queryFn: ({ signal }) => readApi(entryTrashPath, parseEntryTrashResponse,
			AbortSignal.any([signal, AbortSignal.timeout(10_000)]), refresh),
		retry: false,
		networkMode: 'always',
	});

	async function restore(record: TrashedEntryResponse) {
		if (pending) return;
		setPending(record.entry.id);
		setError('');
		setRestored(null);
		try {
			const active = await changeEntryLifecycle('restore', record.entry, session.csrfToken, parseEntryResponse);
			queryClient.setQueryData<TrashedEntryResponse[]>(trashKey, (rows) => rows?.filter(({ entry }) => entry.id !== active.id));
			queryClient.setQueryData([...entriesKey, active.id], active);
			setRestored(active);
			heading.current?.focus();
			await queryClient.invalidateQueries({ queryKey: entriesKey });
		} catch (cause) {
			setError(await entryLifecycleError(cause, 'restore', refresh));
			await trash.refetch();
			heading.current?.focus();
		} finally {
			setPending(null);
		}
	}

	return (
		<section className="entry-page" aria-labelledby="trash-heading">
			<div><Link to="/entries" search={search} resetScroll={false}>Back to time entries</Link></div>
			<h1 id="trash-heading" ref={heading} tabIndex={-1}>Trash</h1>
			<p className="field-hint">You can restore a time entry for 30 days after moving it to Trash.</p>
			{restored ? (
				<p className="feedback" role="status">
					Time entry restored. <Link to="/entries/$entryId" params={{ entryId: restored.id }} search={search}>View restored entry</Link>
				</p>
			) : null}
			{error ? <p className="feedback error" role="alert">{error}</p> : null}
			{trash.isError ? (
				<div className="feedback error catalog-load-error">
					<p role="alert">Could not load Trash. Check your connection and try again.</p>
					<button type="button" onClick={() => void trash.refetch()} disabled={trash.isFetching || !!pending}>Try again</button>
				</div>
			) : trash.isPending ? <p role="status">Loading Trash…</p> : trash.data.length ? (
				<ul className="entry-list">
					{trash.data.map((record) => {
						const { entry, deletedAt, restoreUntil } = record;
						const description = entry.description || 'Untitled time entry';
						const association = [entry.projectName, entry.clientName].filter(Boolean).join(' · ');
						return (
							<li key={entry.id}>
								<article className="panel entry-summary trash-row">
									<div>
										<h2>{description}</h2>
										<p className="entry-summary-values">
											<time dateTime={entry.localDate}>{entry.localDate}</time>
											<span>{formatDuration(entry.durationSeconds)}</span>
											<span>{entry.billableAmountOre === null ? 'Incomplete' : formatSek(entry.billableAmountOre)}</span>
											{entry.invoicedAt ? <span>Invoiced</span> : null}
										</p>
										{association ? <p>{association}</p> : null}
										<p className="field-hint">Moved to Trash <StockholmTime instant={deletedAt} /></p>
										<p className="field-hint">Restore before <StockholmTime instant={restoreUntil} /></p>
									</div>
									<button type="button" disabled={!!pending} aria-label={`Restore ${description}`}
										onClick={() => void restore(record)}>{pending === entry.id ? 'Restoring…' : 'Restore'}</button>
								</article>
							</li>
						);
					})}
				</ul>
			) : <p className="catalog-empty">Trash is empty.</p>}
		</section>
	);
}
