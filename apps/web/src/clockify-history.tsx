import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi, Link } from '@tanstack/react-router';
import { clockifyBatchesPath, idempotencyKeyHeader, parseClockifyImportBatchListResponse, parseClockifyUndoCommitResponse, parseClockifyUndoPreviewResponse } from '@timekeeper/contracts';
import type { ClockifyImportBatchSummary, ClockifyUndoCommitResponse, ClockifyUndoEntry, ClockifyUndoIssue } from '@timekeeper/contracts';
import { useLayoutEffect, useRef, useState } from 'react';
import { ApiRequestError, readApi, writeApi } from './api';
import { authError, useSession } from './auth';
import { readPendingClockifyUndo, writePendingClockifyUndo } from './clockify-import-pending';
import type { PendingUndo } from './clockify-import-pending';
import { formatDuration, StockholmTime } from './entry-display';
import { entriesKey } from './entry-query';
import { formatSek } from './money';
import { operationKey } from './timer-operation';

const historyRoute = getRouteApi('/protected/imports/clockify/history');

const issueText: Record<ClockifyUndoIssue, string> = {
	'already-undone': 'This import was already undone.',
	'entry-changed': 'This entry was changed after import.',
	'entry-invoiced-later': 'This entry has a later invoice action.',
	'entry-deleted': 'This entry is already in Trash.',
	'entry-split': 'This entry was split.',
	'dependent-correction': 'A later Clockify correction still depends on this import.',
	'history-unavailable': 'The saved history needed to undo this import is unavailable.',
};

function BatchCounts({ batch }: { batch: ClockifyImportBatchSummary }) {
	const counts = [
		['Created', batch.createdCount],
		['Updated', batch.updatedExistingCount],
		['Kept existing', batch.keptExistingCount],
		['Already imported', batch.alreadyImportedCount],
		['Excluded', batch.excludedCount],
		['Identical copies omitted', batch.duplicateOmittedCount],
		['Incomplete', batch.incompleteCount],
		['Invoiced', batch.invoicedCount],
	] as const;
	return <dl className="clockify-counts">
		{counts.filter(([, count]) => count > 0).map(([label, count]) => (
			<div key={label}><dt>{label}</dt><dd>{count}</dd></div>
		))}
	</dl>;
}

function UndoValues({ value }: { value: Pick<ClockifyUndoEntry, 'localDate' | 'startAt' | 'endAt' | 'durationSeconds' | 'amountOre'> }) {
	return <p className="entry-summary-values">
		{value.startAt && value.endAt ? <span><StockholmTime instant={value.startAt} /> to <StockholmTime instant={value.endAt} /></span>
			: <time dateTime={value.localDate}>{value.localDate}</time>}
		<span>{formatDuration(value.durationSeconds)}</span>
		<span>{value.amountOre === null ? 'Incomplete' : formatSek(value.amountOre)}</span>
	</p>;
}

function UndoReview({ batchId, account, onConfirm, onCancel }: {
	batchId: string; account: string; onConfirm: (operation: PendingUndo) => void; onCancel: () => void;
}) {
	const { refresh } = useSession();
	const heading = useRef<HTMLHeadingElement>(null);
	const [limit, setLimit] = useState(20);
	const preview = useQuery({
		queryKey: ['clockify-undo-preview', account, batchId],
		queryFn: ({ signal }) => readApi(clockifyBatchesPath + '/' + encodeURIComponent(batchId) + '/undo-preview',
			parseClockifyUndoPreviewResponse, AbortSignal.any([signal, AbortSignal.timeout(15_000)]), refresh),
		retry: false,
		networkMode: 'always',
		gcTime: 0,
		refetchOnWindowFocus: false,
		refetchOnReconnect: false,
	});
	useLayoutEffect(() => heading.current?.focus(), []);
	const data = preview.data;
	const missing = preview.error instanceof ApiRequestError && preview.error.response.status === 404;
	const entries = data ? [...data.entries].sort((a, b) => Number(!!b.issues.length) - Number(!!a.issues.length)) : [];
	return (
		<section className="panel report-section clockify-results" aria-labelledby="clockify-undo-review-heading">
			<h2 id="clockify-undo-review-heading" ref={heading} tabIndex={-1}>Review import undo</h2>
			{preview.isError ? <>
				<p className="feedback error" role="alert">{missing ? 'This import is no longer available.' : 'Could not load the undo review. Check your connection and try again.'}</p>
				<div className="form-actions">
					{!missing ? <button type="button" disabled={preview.isFetching} onClick={() => void preview.refetch()}>Try again</button> : null}
					<button type="button" onClick={onCancel}>Cancel undo</button>
				</div>
			</> : preview.isPending ? <>
				<p role="status">Checking which entries can be undone…</p>
				<button type="button" onClick={onCancel}>Cancel undo</button>
			</> : data ? <>
				<p className="field-hint">Imported <StockholmTime instant={data.batch.committedAt} /></p>
				<dl className="clockify-counts">
					<div><dt>Move to Trash</dt><dd>{data.trashCount}</dd></div>
					<div><dt>Revert updates</dt><dd>{data.revertCount}</dd></div>
					<div><dt>Release import claims</dt><dd>{data.releaseIdentityCount + data.releaseAliasCount}</dd></div>
				</dl>
				<p>Clients and projects stay in place. Rows whose import claims are released can be imported again.</p>
				{!data.canUndo ? <div className="feedback warning" role="status">
					<p>This import can’t be undone.</p>
					{data.issues.length ? <ul>{data.issues.map((issue) => <li key={issue}>{issueText[issue]}</li>)}</ul> : null}
				</div> : null}
				{entries.length ? <ul className="clockify-rows">
					{entries.slice(0, limit).map((entry) => (
						<li key={entry.id} className="clockify-row">
							<strong>{entry.description || 'Untitled time entry'}</strong>
							<p className="field-hint">{entry.action === 'trash' ? 'Move to Trash' : 'Revert update'}{entry.invoicedAt ? ' · Invoiced' : ''}</p>
							<UndoValues value={entry} />
							{entry.restore ? <div className="clockify-undo-restore">
								<p><strong>Restore previous values</strong></p>
								<p>{entry.restore.description || 'Untitled time entry'}</p>
								<UndoValues value={entry.restore} />
							</div> : null}
							{entry.issues.length ? <ul className="feedback warning">{entry.issues.map((issue) => <li key={issue}>{issueText[issue]}</li>)}</ul> : null}
						</li>
					))}
				</ul> : null}
				{limit < entries.length ? <div><button type="button" onClick={() => setLimit(limit + 20)}>Show more entries</button></div> : null}
				<div className="form-actions">
					{data.canUndo && data.previewHash ? (
						<button className="danger" type="button" disabled={preview.isFetching} onClick={() => {
							if (data.previewHash) onConfirm({ batchId, previewHash: data.previewHash, key: operationKey() });
						}}>Confirm undo</button>
					) : null}
					<button type="button" onClick={onCancel}>{data.canUndo ? 'Cancel undo' : 'Back to import history'}</button>
				</div>
			</> : null}
		</section>
	);
}

const rejectedUndo = new Set(['CLOCKIFY_UNDO_CHANGED', 'CLOCKIFY_BATCH_ALREADY_UNDONE', 'CLOCKIFY_BATCH_NOT_FOUND', 'IDEMPOTENCY_CONFLICT']);

export function ClockifyHistory() {
	const search = historyRoute.useSearch();
	const { session, refresh } = useSession();
	const account = session.account?.email ?? '';
	const queryClient = useQueryClient();
	const heading = useRef<HTMLHeadingElement>(null);
	const action = useRef<HTMLButtonElement>(null);
	const trigger = useRef<HTMLButtonElement | null>(null);
	const inFlight = useRef(false);
	const restoreFocus = useRef(false);
	const [pending, setPending] = useState(() => readPendingClockifyUndo(account));
	const [selected, setSelected] = useState<string>();
	const [result, setResult] = useState<ClockifyUndoCommitResponse>();
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState('');
	const historyKey = ['clockify-batches', account] as const;
	const history = useInfiniteQuery({
		queryKey: historyKey,
		initialPageParam: '',
		queryFn: ({ pageParam, signal }) => readApi(clockifyBatchesPath + (pageParam ? '?cursor=' + encodeURIComponent(pageParam) : ''),
			parseClockifyImportBatchListResponse, AbortSignal.any([signal, AbortSignal.timeout(10_000)]), refresh),
		getNextPageParam: (page) => page.nextCursor ?? undefined,
		retry: false,
		networkMode: 'always',
	});
	useLayoutEffect(() => heading.current?.focus(), []);
	useLayoutEffect(() => {
		if (saving) return;
		if (pending) action.current?.focus();
		else if (restoreFocus.current) {
			restoreFocus.current = false;
			(trigger.current?.isConnected ? trigger.current : heading.current)?.focus();
		}
	}, [pending, saving, selected]);

	async function undo(operation: PendingUndo) {
		if (inFlight.current) return;
		inFlight.current = true;
		setSaving(true);
		setError('');
		setPending(operation);
		writePendingClockifyUndo(account, operation);
		try {
			const response = await writeApi(clockifyBatchesPath + '/' + encodeURIComponent(operation.batchId) + '/undo', 'POST', session.csrfToken,
				{ previewHash: operation.previewHash }, {
					headers: { [idempotencyKeyHeader]: operation.key },
					signal: AbortSignal.timeout(40_000),
				});
			setResult(parseClockifyUndoCommitResponse(await response.json()));
			writePendingClockifyUndo(account, null);
			setPending(null);
			setSelected(undefined);
			restoreFocus.current = true;
			trigger.current = null;
			void queryClient.invalidateQueries({ queryKey: entriesKey });
			void queryClient.invalidateQueries({ queryKey: historyKey });
		} catch (cause) {
			if (cause instanceof ApiRequestError && rejectedUndo.has(cause.code ?? '')) {
				writePendingClockifyUndo(account, null);
				setPending(null);
				setSelected(undefined);
				restoreFocus.current = true;
				trigger.current = null;
				setError(cause.code === 'CLOCKIFY_BATCH_ALREADY_UNDONE' ? 'This import was already undone.'
					: cause.code === 'CLOCKIFY_BATCH_NOT_FOUND' ? 'This import is no longer available.'
					: 'Undo could not proceed. Open a fresh review to check what changed.');
				void queryClient.invalidateQueries({ queryKey: historyKey });
			} else {
				setError(cause instanceof ApiRequestError && [401, 403].includes(cause.response.status)
					? await authError(cause.response, refresh)
					: 'Could not confirm whether the undo finished. Retry the same request to check its result.');
			}
		} finally {
			inFlight.current = false;
			setSaving(false);
		}
	}

	const batches = history.data?.pages.flatMap((page) => page.batches) ?? [];
	return (
		<section className="entry-page clockify-page" aria-labelledby="clockify-history-heading">
			<h1 id="clockify-history-heading" className="entry-heading" ref={heading} tabIndex={-1}>Clockify import history</h1>
			{!pending ? <div className="form-actions">
				<Link to="/imports/clockify" search={search}>Inspect a Clockify export</Link>
				<Link to="/entries" search={search} state={{ clockifyInspectionReturned: true }}>Back to time entries</Link>
			</div> : null}
			{result ? <p className="feedback" role="status">
				Import undone. Moved to Trash: {result.trashedCount}. Reverted: {result.revertedCount}.
				{result.trashedCount ? <> <Link to="/entries/trash" search={search}>View Trash</Link></> : null}
			</p> : null}
			{error ? <p className="feedback error" role="alert">{error}</p> : null}
			{pending ? <section className="panel report-section clockify-results" aria-label="Pending import undo" aria-busy={saving}>
				{saving ? <p role="status">Undoing the import…</p> : <>
					<p>Retry the confirmed undo to check its result.</p>
					<button className="primary" ref={action} type="button" onClick={() => void undo(pending)}>Retry undo</button>
				</>}
			</section> : selected ? <UndoReview key={selected} batchId={selected} account={account} onConfirm={(operation) => void undo(operation)}
				onCancel={() => {
					restoreFocus.current = true;
					setSelected(undefined);
				}} /> : null}
			{!pending ? <div hidden={!!selected}>
				{history.isPending ? <p role="status">Loading import history…</p> : null}
				{history.isError && !batches.length ? <div className="feedback error catalog-load-error">
					<p role="alert">Could not load import history. Check your connection and try again.</p>
					<button type="button" disabled={history.isFetching} onClick={() => void history.refetch()}>Try again</button>
				</div> : null}
				{history.isSuccess && !batches.length ? <p className="catalog-empty">No Clockify imports yet.</p> : null}
				{batches.length ? <ul className="entry-list">
					{batches.map((batch) => <li key={batch.id}>
						<article className="panel report-section clockify-results">
							<h2>Imported <StockholmTime instant={batch.committedAt} /></h2>
							<p className="field-hint">{batch.sourceTimeZone}</p>
							<BatchCounts batch={batch} />
							{batch.undoneAt ? <p>Undone <StockholmTime instant={batch.undoneAt} /></p> : <div>
								<button type="button" onClick={(event) => {
									trigger.current = event.currentTarget;
									setError('');
									setResult(undefined);
									setSelected(batch.id);
								}}>Review undo</button>
							</div>}
						</article>
					</li>)}
				</ul> : null}
				{history.isFetchNextPageError ? <p className="feedback error" role="alert">Could not load older imports. Try again.</p> : null}
				{history.hasNextPage ? <div className="form-actions">
					<button type="button" disabled={history.isFetching} onClick={() => void history.fetchNextPage()}>
						{history.isFetchingNextPage ? 'Loading older imports…' : 'Load older imports'}
					</button>
				</div> : null}
			</div> : null}
		</section>
	);
}
