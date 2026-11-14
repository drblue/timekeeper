import {
	bulkEntryCommitPath, bulkEntryPreviewPath, idempotencyKeyHeader,
	parseBulkEntryCommitResponse, parseBulkEntryPreviewResponse,
} from '@timekeeper/contracts';
import type { BulkEntryCommitResponse, BulkEntryPreviewBody, BulkEntryPreviewResponse, WorkListQuery, WorkListRange } from '@timekeeper/contracts';
import { useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode, SubmitEvent } from 'react';
import { ApiRequestError, writeApi } from './api';
import { authError, useSession } from './auth';
import { readBulkOperation, writeBulkOperation } from './bulk-operation';
import type { BulkOperation } from './bulk-operation';
import { formatDuration } from './entry-display';
import { BulkSplitReview } from './bulk-split-review';
import { InvoiceFields, invoiceMetadata } from './invoice-fields';
import { formatSek } from './money';
import { operationKey } from './timer-operation';

type Action = BulkEntryPreviewBody['action'];
type Selection = BulkEntryPreviewBody['selection'];

const actionLabels: Record<Action, string> = {
	'mark-invoiced': 'Mark as invoiced',
	'unmark-invoiced': 'Unmark invoice',
	delete: 'Move to Trash',
};

const issueLabels: Record<BulkEntryPreviewResponse['entries'][number]['issues'][number], string> = {
	'not-completed': 'Work is incomplete.',
	'non-billable': 'Work is non-billable.',
	'already-invoiced': 'Already marked as invoiced.',
	'not-invoiced': 'Has no invoice marking.',
	'invoiced-delete': 'Unmark the invoice before moving this entry to Trash.',
	'outside-date-range': 'Part of the entry is outside the selected dates. Widen the date range to include the whole entry.',
	'outside-selection': 'The entry is unavailable or no longer matches these filters.',
};

export interface BulkRowSelection {
	checked: (id: string) => boolean;
	toggle: (id: string) => void;
	disabled: boolean;
}

function entryCount(count: number) {
	return count === 1 ? '1 entry' : count + ' entries';
}

export function WorkListBulk({ account, scope, filters, range, hasEntries, onSaved, children }: {
	account: string;
	scope: string;
	filters: WorkListQuery;
	range: WorkListRange | undefined;
	hasEntries: boolean;
	onSaved: (result: BulkEntryCommitResponse) => void;
	children: (selection?: BulkRowSelection) => ReactNode;
}) {
	const { session, refresh } = useSession();
	const [selection, setSelection] = useState<Selection>();
	const [selectedRange, setSelectedRange] = useState<WorkListRange>();
	const [action, setAction] = useState<Action>('mark-invoiced');
	const [review, setReview] = useState<{ result: BulkEntryPreviewResponse; body: BulkEntryPreviewBody }>();
	const [metadata, setMetadata] = useState<BulkEntryPreviewBody['metadata']>();
	const [operation, setOperation] = useState(() => readBulkOperation(account));
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState('');
	const [dateError, setDateError] = useState('');
	const [stale, setStale] = useState(false);
	const trigger = useRef<HTMLButtonElement>(null);
	const heading = useRef<HTMLHeadingElement>(null);
	const reviewHeading = useRef<HTMLHeadingElement>(null);
	const dateInput = useRef<HTMLInputElement>(null);
	const activeScope = useRef(scope);
	const scopeVersion = useRef(0);
	const focusAfter = useRef<'trigger' | 'selection' | 'review' | 'date'>(undefined);
	const rangeChanged = !!(selectedRange && range &&
		(selectedRange.from !== range.from || selectedRange.to !== range.to));
	const locked = busy || !!operation || !!review;
	const count = selection?.mode === 'explicit' ? selection.entryIds.length : undefined;
	const selectable = !!range && hasEntries;
	const previewResult = review?.result;
	const splitRequested = review?.body.splitOutsideRange === true;
	const split = splitRequested && !!previewResult?.entries.some((entry) => entry.split);
	const blocked = previewResult?.entries.filter((entry) => entry.issues.length);
	const incomplete = previewResult?.entries.filter((entry) => entry.amountOre === null).length ?? 0;

	const canReviewSplit = previewResult?.action === 'mark-invoiced' && !splitRequested && !!blocked?.length &&
		blocked.every((entry) => entry.split && entry.issues.every((issue) => issue === 'outside-date-range'));

	useLayoutEffect(() => {
		if (activeScope.current === scope) return;
		activeScope.current = scope;
		scopeVersion.current += 1;
		setSelection(undefined);
		setSelectedRange(undefined);
		setReview(undefined);
		setAction('mark-invoiced');
		setMetadata(undefined);
		setDateError('');
		setStale(false);
		if (!operation) setError('');
	}, [scope, operation]);

	useLayoutEffect(() => {
		const target = focusAfter.current;
		focusAfter.current = undefined;
		if (target === 'trigger') trigger.current?.focus();
		if (target === 'selection') heading.current?.focus();
		if (target === 'review') reviewHeading.current?.focus();
		if (target === 'date') dateInput.current?.focus();
	});

	function startSelection() {
		focusAfter.current = 'selection';
		setSelectedRange(range);
		setSelection({ mode: 'explicit', entryIds: [] });
		setError('');
	}

	function closeSelection() {
		focusAfter.current = 'trigger';
		setSelection(undefined);
		setSelectedRange(undefined);
		setReview(undefined);
		setAction('mark-invoiced');
		setMetadata(undefined);
		setError('');
		setDateError('');
		setStale(false);
	}

	function changeSelection(next: Selection) {
		setSelection(next);
		setError('');
	}

	function toggle(id: string) {
		if (!selection || selection.mode !== 'explicit' || locked) return;
		if (selection.entryIds.includes(id)) {
			changeSelection({ mode: 'explicit', entryIds: selection.entryIds.filter((entryId) => id !== entryId) });
		} else if (selection.entryIds.length < 1_000) {
			changeSelection({ mode: 'explicit', entryIds: [...selection.entryIds, id] });
		} else {
			setError('Select up to 1,000 entries individually, or use Select all matching.');
		}
	}

	function editSelection() {
		focusAfter.current = 'selection';
		setReview(undefined);
		setError('');
		setStale(false);
	}

	function preview(event: SubmitEvent<HTMLFormElement>) {
		event.preventDefault();
		if (locked || !selection || !selectedRange || count === 0 || rangeChanged) return;
		void loadPreview({
			action, selection, filters: { ...filters, preset: 'custom', ...selectedRange },
			...(action === 'mark-invoiced' ? { metadata: invoiceMetadata(event.currentTarget) } : {}),
		});
	}

	async function loadPreview(body: BulkEntryPreviewBody) {
		const version = scopeVersion.current;
		setBusy(true);
		setError('');
		setDateError('');
		try {
			const response = await writeApi(bulkEntryPreviewPath, 'POST', session.csrfToken, body, {
				signal: AbortSignal.timeout(10_000),
			});
			const next = parseBulkEntryPreviewResponse(await response.json());
			if (version !== scopeVersion.current) return;
			focusAfter.current = 'review';
			setMetadata(body.metadata);
			setReview({ result: next, body });
		} catch (cause) {
			if (version !== scopeVersion.current) return;
			if (cause instanceof ApiRequestError && cause.code === 'INVALID_INVOICE_DATE') {
				focusAfter.current = 'date';
				setDateError('Enter a valid invoice date.');
			} else if (cause instanceof ApiRequestError && [401, 403].includes(cause.response.status)) {
				setError(await authError(cause.response, refresh));
			} else {
				setError('Could not review this selection. Check your connection and try again.');
			}
		} finally {
			setBusy(false);
		}
	}

	async function commit(request: BulkOperation) {
		if (busy) return;
		const version = scopeVersion.current;
		setBusy(true);
		setError('');
		focusAfter.current = 'review';
		setOperation(request);
		writeBulkOperation(account, request);
		try {
			const response = await writeApi(bulkEntryCommitPath, 'POST', session.csrfToken, {
				previewToken: request.previewToken,
			}, { headers: { [idempotencyKeyHeader]: request.key }, signal: AbortSignal.timeout(10_000) });
			const result = parseBulkEntryCommitResponse(await response.json());
			writeBulkOperation(account, null);
			setOperation(null);
			closeSelection();
			focusAfter.current = undefined;
			onSaved(result);
		} catch (cause) {
			if (cause instanceof ApiRequestError && [401, 403].includes(cause.response.status)) {
				setError(await authError(cause.response, refresh));
			} else if (cause instanceof ApiRequestError &&
				['BULK_PREVIEW_CHANGED', 'BULK_PREVIEW_EXPIRED', 'INVALID_BULK_PREVIEW', 'IDEMPOTENCY_CONFLICT'].includes(cause.code ?? '')) {
				writeBulkOperation(account, null);
				setOperation(null);
				setStale(true);
				focusAfter.current = review && version === scopeVersion.current ? 'review' : 'trigger';
				setError(cause.code === 'BULK_PREVIEW_CHANGED'
					? 'The selected work changed. Review an updated selection before confirming.'
					: 'This review is no longer available. Review the selection again.');
			} else {
				focusAfter.current = 'review';
				setError('Could not confirm the bulk action. Retry the same request to check its result.');
			}
		} finally {
			setBusy(false);
		}
	}

	const rowSelection: BulkRowSelection | undefined = selection ? {
		checked: (id) => selection.mode === 'all-matching' || selection.entryIds.includes(id),
		toggle,
		disabled: locked || rangeChanged || selection.mode === 'all-matching',
	} : undefined;

	return (
		<>
			{!selection && !operation ? (
				<div className="work-list-select">
					<button ref={trigger} type="button" disabled={!selectable} onClick={startSelection}>Select entries</button>
					{error ? <p className="feedback warning" role="alert">{error}</p> : null}
				</div>
			) : (
				<section className="panel work-list-bulk" aria-labelledby="bulk-heading" aria-busy={busy}>
					{operation ? (
						<>
							<h2 id="bulk-heading" tabIndex={-1} ref={reviewHeading}>{busy ? 'Applying bulk action…' : 'Check bulk action'}</h2>
							<p>{operation.split ? 'Split and mark as invoiced' : actionLabels[operation.action]} · {entryCount(operation.count)}</p>
							{error ? <p className="feedback error" role="alert">{error}</p> : null}
							{!busy ? <div className="form-actions">
								<button type="button" className="primary" onClick={() => void commit(operation)}>Retry confirmation</button>
							</div> : null}
						</>
					) : (
						<>
							<h2 id="bulk-heading" tabIndex={-1} ref={heading}>Select time entries</h2>
							<p role="status">{selection?.mode === 'all-matching'
								? 'All matching entries selected across pages.'
								: entryCount(count ?? 0) + ' selected.'}</p>
							{rangeChanged ? <p className="feedback warning" role="alert">The displayed dates changed. Cancel and select entries again.</p> : null}
							<form className="record-editor" onSubmit={preview} hidden={!!review}>
								<div className="form-actions">
									<button type="button" disabled={busy || rangeChanged || selection?.mode === 'all-matching'}
										onClick={() => changeSelection({ mode: 'all-matching' })}>Select all matching</button>
									<button type="button" disabled={busy || count === 0}
										onClick={() => changeSelection({ mode: 'explicit', entryIds: [] })}>Clear selection</button>
								</div>
								<div className="field work-list-bulk-action">
									<label htmlFor="bulk-action">Bulk action</label>
									<select id="bulk-action" disabled={busy} value={action} onChange={(event) => {
										setAction(event.target.value as Action);
										setError('');
										setDateError('');
									}}>
										{Object.entries(actionLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
									</select>
								</div>
								{action === 'mark-invoiced' ? <InvoiceFields values={metadata} disabled={busy} dateInput={dateInput}
									dateError={dateError} onDateChange={() => setDateError('')} /> : null}
								<div className="form-actions">
									<button type="submit" className="primary" disabled={busy || count === 0 || rangeChanged}>
										{busy ? 'Reviewing…' : 'Review selection'}
									</button>
									<button type="button" disabled={busy} onClick={closeSelection}>Cancel selection</button>
								</div>
							</form>
							{error ? <p className="feedback warning" role="alert">{error}</p> : null}
							{previewResult ? (
								<div className="work-list-bulk-review">
									<h3 tabIndex={-1} ref={reviewHeading}>{split ? 'Split and mark as invoiced' : actionLabels[previewResult.action]}</h3>
									<p>{split ? 'Work dates' : 'Whole entries'} · {previewResult.range.from} to {previewResult.range.to}</p>
									<dl className={split ? "entry-invoice-values bulk-split-totals" : "entry-invoice-values"} aria-label="Selected whole entry totals">
										<div><dt>{split ? 'Selected entries' : 'Entries'}</dt><dd>{previewResult.count}</dd></div>
										<div><dt>Duration</dt><dd>{formatDuration(previewResult.seconds)}</dd></div>
										<div><dt>{incomplete ? 'Known billable amount' : 'Billable amount'}</dt><dd>{formatSek(previewResult.amountOre)}</dd></div>
									</dl>
									{metadata ? (
										<dl className="entry-invoice-values" aria-label="Invoice details for the selection">
											<div><dt>Invoice number</dt><dd>{metadata.invoiceNumber ?? '—'}</dd></div>
											<div><dt>Invoice date</dt><dd>{metadata.invoiceDate ?? '—'}</dd></div>
											{metadata.invoiceReference ? <div className="entry-invoice-reference">
												<dt>Invoice reference</dt><dd>{metadata.invoiceReference}</dd>
											</div> : null}
										</dl>
									) : null}
									{split ? <BulkSplitReview preview={previewResult} /> : null}
									{incomplete > 0 ? (
										<p className="field-hint">Incomplete work has no saved billable amount.</p>
									) : null}
									{blocked?.length ? (
										<>
											<p className="feedback warning" role="status">{canReviewSplit
												? 'Some entries cross the selected dates. Review a split to mark only work within the range.'
												: 'Resolve the issues below before applying this action to the selection.'}</p>
											<ul className="work-list-bulk-issues">
												{blocked.map((entry) => <li key={entry.id}>
													<strong>{entry.description || 'Untitled time entry'}</strong>
													{' · ' + entry.issues.map((issue) => canReviewSplit && issue === 'outside-date-range'
														? 'Part of the entry is outside the selected dates.'
														: issueLabels[issue]).join(' ')}
												</li>)}
											</ul>
										</>
									) : previewResult.count === 0 ? <p className="feedback warning">No entries match this selection.</p> : null}
									{previewResult.entries.some((entry) => !split || !entry.split) ? (
										<details>
											<summary>{split ? 'View entries being marked in full' : 'View selected entries'}</summary>
											<ul className="work-list-bulk-issues">
												{previewResult.entries.filter((entry) => !split || !entry.split).map((entry) => <li key={entry.id}>
													{entry.description || 'Untitled time entry'} · {formatDuration(entry.seconds)}
												</li>)}
											</ul>
										</details>
									) : null}
									{previewResult.action === 'delete' ? <p className="field-hint">Entries in Trash can be restored for 30 days.</p> : null}
									{previewResult.action === 'unmark-invoiced' ? <p className="field-hint">Unmarking clears the saved invoice details in Timekeeper.</p> : null}
									<div className="form-actions">
										{canReviewSplit && review && !stale && !rangeChanged ? (
											<button type="button" className="primary" disabled={busy}
												onClick={() => void loadPreview({ ...review.body, splitOutsideRange: true })}>
												{busy ? 'Reviewing…' : 'Review split and mark'}
											</button>
										) : null}
										{previewResult.canCommit && previewResult.previewToken && !stale && !rangeChanged ? (
											<button type="button" className="primary" disabled={busy} onClick={() => {
												if (previewResult.previewToken) void commit({ previewToken: previewResult.previewToken, key: operationKey(),
													action: previewResult.action, count: previewResult.count, split });
											}}>Confirm {split ? 'split and mark' : actionLabels[previewResult.action].toLowerCase()}</button>
										) : null}
										<button type="button" disabled={busy} onClick={editSelection}>{stale ? 'Review again' : 'Edit selection'}</button>
										<button type="button" disabled={busy} onClick={closeSelection}>Cancel selection</button>
									</div>
								</div>
							) : null}
						</>
					)}
				</section>
			)}
			{children(rowSelection)}
		</>
	);
}
