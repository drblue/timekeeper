import { entriesPath, parseEntryResponse } from '@timekeeper/contracts';
import type { EntryInvoiceBody, EntryResponse } from '@timekeeper/contracts';
import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { SubmitEvent } from 'react';
import { ApiRequestError, writeApi } from './api';
import { authError, useSession } from './auth';
import { formatDuration, StockholmTime } from './entry-display';
import { formatSek } from './money';
import { InvoiceFields, invoiceMetadata } from './invoice-fields';

type InvoiceAction = 'mark' | 'edit' | 'unmark';

const labels = {
	mark: { heading: 'Mark entry as invoiced', action: 'Confirm invoice marking', done: 'Time entry marked as invoiced.' },
	edit: { heading: 'Edit invoice details', action: 'Save invoice details', done: 'Invoice details updated.' },
	unmark: { heading: 'Unmark this invoice?', action: 'Confirm unmark', done: 'Time entry unmarked.' },
};

export function EntryInvoice({ entry, onSaved, onRefresh }: {
	entry: EntryResponse;
	onSaved: (entry: EntryResponse, message: string) => void;
	onRefresh: () => Promise<EntryResponse | undefined>;
}) {
	const { session, refresh } = useSession();
	const id = useId();
	const [draft, setDraft] = useState<{ action: InvoiceAction; entry: EntryResponse } | null>(null);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState('');
	const [dateError, setDateError] = useState('');
	const dateInput = useRef<HTMLInputElement>(null);
	const [mustCheck, setMustCheck] = useState(false);
	const panelHeading = useRef<HTMLHeadingElement>(null);
	const formHeading = useRef<HTMLHeadingElement>(null);
	const returnFocus = useRef<InvoiceAction | null>(null);
	const reviewAfterRefresh = useRef(false);
	const markTrigger = useRef<HTMLButtonElement>(null);
	const editTrigger = useRef<HTMLButtonElement>(null);
	const unmarkTrigger = useRef<HTMLButtonElement>(null);
	const changed = !!draft && entry.revision !== draft.entry.revision;
	const canMark = entry.completion === 'complete' && entry.billable;
	const action = draft?.action;
	const invoiced = !!entry.invoicedAt;

	useLayoutEffect(() => {
		if (action) {
			formHeading.current?.focus();
		} else if (returnFocus.current) {
			const target = returnFocus.current === 'mark' ? markTrigger : returnFocus.current === 'edit' ? editTrigger : unmarkTrigger;
			returnFocus.current = null;
			(target.current ?? panelHeading.current)?.focus();
		}
	}, [action]);

	function open(next: InvoiceAction) {
		setError('');
		setDateError('');
		setMustCheck(false);
		setDraft({ action: next, entry });
	}

	function cancel() {
		returnFocus.current = action ?? null;
		setDraft(null);
		setError('');
		setDateError('');
		setMustCheck(false);
	}

	async function checkSavedEntry() {
		setPending(true);
		try {
			const current = await onRefresh();
			if (!current) {
				setError('Could not load the saved entry. Check your connection and try again.');
				return;
			}
			setError('The saved details are up to date. Review them before trying again.');
			reviewAfterRefresh.current = true;
			setMustCheck(false);
		} finally {
			setPending(false);
		}
	}

	async function submit(event: SubmitEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!draft || changed || mustCheck || pending) return;
		const body: EntryInvoiceBody = { revision: draft.entry.revision,
			...(draft.action !== 'unmark' ? invoiceMetadata(event.currentTarget) : {}) };
		setPending(true);
		setError('');
		setDateError('');
		try {
			const path = `${entriesPath}/${encodeURIComponent(entry.id)}/${draft.action === 'unmark' ? 'uninvoice' : 'invoice'}`;
			const response = await writeApi(path, draft.action === 'edit' ? 'PUT' : 'POST',
				session.csrfToken, body, { signal: AbortSignal.timeout(10_000) });
			const updated = parseEntryResponse(await response.json());
			setDraft(null);
			onSaved(updated, labels[draft.action].done);
		} catch (cause) {
			if (cause instanceof ApiRequestError) {
				if (cause.response.status === 401 || cause.response.status === 403) {
					setError(await authError(cause.response, refresh));
				} else if (cause.code === 'INVALID_INVOICE_DATE') {
					setDateError('Enter a valid invoice date.');
				} else if (cause.code === 'ENTRY_NOT_INVOICE_ELIGIBLE') {
					setMustCheck(true);
					setError('Only completed billable work can be marked as invoiced. Check the saved entry.');
				} else if (['REVISION_CONFLICT', 'ENTRY_ALREADY_INVOICED', 'ENTRY_NOT_INVOICED'].includes(cause.code ?? '')) {
					setMustCheck(true);
					setError('The saved entry changed in another session. Check the saved entry before trying again.');
				} else if (cause.response.status === 404) {
					setMustCheck(true);
					setError('This time entry is no longer available.');
				} else {
					setError('Could not save the invoice details. Check the values and try again.');
				}
			} else {
				setMustCheck(true);
				setError('Could not confirm the invoice change. Check the saved entry before trying again.');
			}
		} finally {
			setPending(false);
		}
	}

	useLayoutEffect(() => {
		if (pending) return;
		if (reviewAfterRefresh.current) {
			reviewAfterRefresh.current = false;
			formHeading.current?.focus();
		} else if (dateError) {
			dateInput.current?.focus();
		}
	}, [dateError, pending]);

	return (
		<section className="panel entry-invoice" aria-labelledby={id}>
			<h2 className="entry-completion-heading" id={id} tabIndex={-1} ref={panelHeading}>Invoice</h2>
			<dl className="entry-invoice-values">
				<div><dt>Status</dt><dd>{invoiced ? 'Invoiced' : !entry.billable ? 'Non-billable' : entry.completion === 'complete' ? 'Not yet invoiced' : 'Incomplete'}</dd></div>
				{entry.invoicedAt ? (
					<>
						<div><dt>Invoice number</dt><dd>{entry.invoiceNumber ?? '—'}</dd></div>
						<div><dt>Invoice date</dt><dd>{entry.invoiceDate ? <time dateTime={entry.invoiceDate}>{entry.invoiceDate}</time> : '—'}</dd></div>
						<div><dt>Marked as invoiced (Stockholm)</dt><dd><StockholmTime instant={entry.invoicedAt} /></dd></div>
						{entry.invoiceReference ? <div className="entry-invoice-reference"><dt>Invoice reference</dt><dd>{entry.invoiceReference}</dd></div> : null}
					</>
				) : null}
			</dl>
			{!draft ? (
				<div className="form-actions">
					{invoiced ? (
						<>
							<button type="button" ref={editTrigger} onClick={() => open('edit')}>Edit invoice details</button>
							<button type="button" ref={unmarkTrigger} onClick={() => open('unmark')}>Unmark invoice</button>
						</>
					) : canMark ? (
						<button type="button" ref={markTrigger} onClick={() => open('mark')}>Mark as invoiced</button>
					) : <p className="field-hint">Only completed billable work can be marked as invoiced.</p>}
				</div>
			) : (
				<form className="record-editor entry-invoice-form" aria-busy={pending} onSubmit={(event) => void submit(event)}>
					<h3 className="entry-completion-heading" tabIndex={-1} ref={formHeading}>{labels[draft.action].heading}</h3>
					{draft.action === 'mark' ? (
						<p className="field-hint">1 entry · {formatDuration(draft.entry.durationSeconds)} · {formatSek(draft.entry.billableAmountOre ?? '0')}.
							Marking applies to the whole time entry.</p>
					) : draft.action === 'unmark' ? (
						<p className="field-hint">Unmarking clears the saved invoice details in Timekeeper and unlocks work edits and deletion.</p>
					) : null}
					{changed ? <p className="feedback warning" role="alert">The saved entry changed. Review the current details above. Cancel to start again.</p> : null}
					{error ? <p className="feedback error" role="alert">{error}</p> : null}
					{draft.action !== 'unmark' ? (
						<InvoiceFields values={draft.entry} disabled={pending} dateInput={dateInput}
							dateError={dateError} onDateChange={() => setDateError('')} />
					) : null}
					<div className="form-actions">
						{mustCheck ? (
							<button type="button" disabled={pending} onClick={() => void checkSavedEntry()}>Check saved entry</button>
						) : (
							<button type="submit" className="primary" disabled={pending || changed}>
								{pending ? 'Saving…' : labels[draft.action].action}
							</button>
						)}
						<button type="button" disabled={pending} onClick={cancel}>Cancel invoice change</button>
					</div>
				</form>
			)}
		</section>
	);
}
