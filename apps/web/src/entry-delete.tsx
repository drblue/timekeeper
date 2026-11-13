import { parseTrashedEntryResponse } from '@timekeeper/contracts';
import type { EntryResponse } from '@timekeeper/contracts';
import { useLayoutEffect, useRef, useState } from 'react';
import { useSession } from './auth';
import { changeEntryLifecycle, entryLifecycleError } from './entry-lifecycle';

export function EntryDelete({ entry, onDeleted, onRefresh }: {
	entry: EntryResponse;
	onDeleted: () => void;
	onRefresh: () => Promise<EntryResponse | undefined>;
}) {
	const { session, refresh } = useSession();
	const [confirmation, setConfirmation] = useState<EntryResponse | null>(null);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState('');
	const [needsRefresh, setNeedsRefresh] = useState(false);
	const openButton = useRef<HTMLButtonElement>(null);
	const heading = useRef<HTMLHeadingElement>(null);
	const restoreFocus = useRef(false);
	const changed = confirmation && (confirmation.revision !== entry.revision || entry.invoicedAt);

	useLayoutEffect(() => {
		if (confirmation) heading.current?.focus();
		else if (restoreFocus.current) {
			restoreFocus.current = false;
			openButton.current?.focus();
		}
	}, [confirmation]);

	function close() {
		restoreFocus.current = true;
		setConfirmation(null);
		setError('');
		setNeedsRefresh(false);
	}

	async function reload() {
		setPending(true);
		const latest = await onRefresh();
		setPending(false);
		if (latest) close();
		else setError('Could not load the current entry. Check your connection and try again.');
	}

	async function remove() {
		if (!confirmation || changed || pending || needsRefresh) return;
		setPending(true);
		setError('');
		try {
			await changeEntryLifecycle('delete', confirmation, session.csrfToken, parseTrashedEntryResponse);
			onDeleted();
		} catch (cause) {
			setNeedsRefresh(true);
			setError(await entryLifecycleError(cause, 'delete', refresh));
		} finally {
			setPending(false);
		}
	}

	return confirmation ? (
		<div className="feedback warning entry-delete-confirmation" aria-busy={pending}>
			<h2 className="entry-completion-heading" tabIndex={-1} ref={heading}>Move this entry to Trash?</h2>
			<p>{confirmation.description || 'Untitled time entry'} will be removed from the work list and totals. You can restore it from Trash within 30 days.</p>
			{changed ? <p role="alert">This entry changed. Review the latest details before moving it to Trash.</p> : null}
			{error ? <p role="alert">{error}</p> : null}
			<div className="form-actions">
				{needsRefresh || changed ? (
					<button type="button" disabled={pending} onClick={() => void reload()}>Check saved entry</button>
				) : (
					<button type="button" className="danger" disabled={pending} onClick={() => void remove()}>
						{pending ? 'Moving to Trash…' : 'Move to Trash'}
					</button>
				)}
				<button type="button" disabled={pending} onClick={close}>Cancel</button>
			</div>
		</div>
	) : (
		<div className="form-actions">
			<button type="button" ref={openButton} className="danger" onClick={() => setConfirmation(entry)}>Move to Trash</button>
		</div>
	);
}
