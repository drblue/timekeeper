import { useQuery } from '@tanstack/react-query';
import { entriesPath, parseContinueEntryPreview } from '@timekeeper/contracts';
import type { ContinueTimerBody, StopTimerBody } from '@timekeeper/contracts';
import { useEffect, useId, useRef, useState } from 'react';
import type { SubmitEvent } from 'react';
import { ApiRequestError, readApi } from './api';
import { useSession } from './auth';
import { formatSek } from './money';
import { useTimerActions } from './workspace-timer';

export function EntryContinue({ entryId, onFallbackFocus }: { entryId: string; onFallbackFocus: () => void }) {
	const { refresh } = useSession();
	const { timer, canAct, continueWork } = useTimerActions();
	const [target, setTarget] = useState<StopTimerBody | null | undefined>(undefined);
	const [rateChoice, setRateChoice] = useState<ContinueTimerBody['rateChoice']>('saved');
	const [error, setError] = useState('');
	const [submitting, setSubmitting] = useState(false);
	const trigger = useRef<HTMLButtonElement>(null);
	const heading = useRef<HTMLHeadingElement>(null);
	const restoreFocus = useRef(false);
	const id = useId();
	const open = target !== undefined;
	const preview = useQuery({
		queryKey: ['continue-entry', entryId],
		queryFn: ({ signal }) => readApi(`${entriesPath}/${encodeURIComponent(entryId)}/continue`, parseContinueEntryPreview,
			AbortSignal.any([signal, AbortSignal.timeout(10_000)]), refresh),
		enabled: open,
		retry: false,
		refetchOnWindowFocus: false,
		refetchOnReconnect: false,
	});
	const work = preview.data;
	const changedTimer = open && timer !== undefined && (target
		? timer?.id !== target.timerId || timer.revision !== target.revision
		: !!timer);
	const rateDiffers = !!work && work.assignedRateOrePerHour !== work.currentDefaultRateOrePerHour;
	const association = work ? [work.projectName, work.clientName].filter(Boolean).join(' · ') : '';

	useEffect(() => {
		if (open) {
			heading.current?.focus();
		} else if (!open && restoreFocus.current) {
			restoreFocus.current = false;
			if (trigger.current && !trigger.current.disabled) trigger.current.focus();
			else onFallbackFocus();
		}
	}, [open, onFallbackFocus]);

	function review() {
		if (timer === undefined) return;
		setError('');
		setRateChoice('saved');
		setTarget(timer ? { timerId: timer.id, revision: timer.revision } : null);
		void preview.refetch();
	}

	function close() {
		restoreFocus.current = true;
		setTarget(undefined);
		setError('');
	}

	async function submit(event: SubmitEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!work || !canAct || submitting || preview.isError || preview.isFetching || changedTimer || target === undefined) return;
		setError('');
		setSubmitting(true);
		const problem = await continueWork({
			entryId: work.entryId,
			entryRevision: work.revision,
			rateChoice: rateDiffers ? rateChoice : 'saved',
			expectedDefaultRateOrePerHour: work.currentDefaultRateOrePerHour,
		}, target);
		setSubmitting(false);
		if (problem) {
			setError(problem);
			setRateChoice('saved');
			void preview.refetch();
		} else {
			close();
		}
	}

	const unavailable = preview.error instanceof ApiRequestError &&
		['INVALID_CLIENT', 'INVALID_PROJECT'].includes(preview.error.code ?? '');
	const rateLabel = (rate: string | null) => rate === null ? 'No rate' : `${formatSek(rate)}/hour`;

	return (
		<div className="entry-continue">
			<div className="form-actions">
				<button type="button" ref={trigger} disabled={submitting || (!canAct && !open)} aria-expanded={open} aria-controls={id}
					onClick={open ? close : review}>Continue work</button>
			</div>
			<div id={id} hidden={!open}>
				{open ? (
					<form className="panel record-editor" onSubmit={(event) => void submit(event)} aria-busy={submitting}>
						<h2 className="entry-completion-heading" tabIndex={-1} ref={heading}>Continue this work</h2>
						<p className="field-hint">{target
							? 'Stop and save the running timer, then start a new timer for this entry.'
							: 'Start a new timer for this entry.'}</p>
						{changedTimer ? (
							<div className="feedback warning">
								<p role="status">The running timer changed. Review the current timer before continuing.</p>
								<button type="button" disabled={!canAct} onClick={review}>Review current timer</button>
							</div>
						) : null}
						{error ? <p className="feedback error" role="alert">{error}</p> : null}
						{preview.isError ? (
							<div className="feedback error catalog-load-error">
								<p role="alert">{unavailable
									? 'The project or client for this entry is unavailable.'
									: 'Could not load the details for continuing this entry.'}</p>
								<button type="button" disabled={preview.isFetching} onClick={() => void preview.refetch()}>Check work details</button>
							</div>
						) : null}
						{preview.isPending ? <p className="field-hint" role="status">Checking work details…</p> : null}
						{work && !preview.isError ? (
							<div className="timer-context">
								<p><strong>{work.description || 'Untitled time entry'}</strong></p>
								<p className="field-hint">{[association, work.billable ? 'Billable' : 'Non-billable'].filter(Boolean).join(' · ')}</p>
							</div>
						) : null}
						{work && !preview.isError ? (
							rateDiffers ? (
								<fieldset className="entry-type" disabled={!canAct || preview.isFetching || changedTimer}>
									<legend>Hourly rate for the new timer</legend>
									<p className="field-hint">The current default differs from the rate saved on this entry.</p>
									<div className="entry-rate-options">
										<label className="catalog-checkbox">
											<input type="radio" name={id + '-rate'} checked={rateChoice === 'saved'} onChange={() => setRateChoice('saved')} />
											Keep saved rate ({rateLabel(work.assignedRateOrePerHour)})
										</label>
										<label className="catalog-checkbox">
											<input type="radio" name={id + '-rate'} checked={rateChoice === 'current'} onChange={() => setRateChoice('current')} />
											Use current default ({rateLabel(work.currentDefaultRateOrePerHour)})
										</label>
									</div>
								</fieldset>
							) : <p className="field-hint">Saved hourly rate · {rateLabel(work.assignedRateOrePerHour)}</p>
						) : null}
						<div className="form-actions">
							<button className="primary" type="submit" disabled={!canAct || !work || preview.isError || preview.isFetching || changedTimer}>
								{target ? 'Stop and continue' : 'Start continued timer'}
							</button>
							<button type="button" disabled={submitting} onClick={close}>Cancel continue</button>
						</div>
					</form>
				) : null}
			</div>
		</div>
	);
}
