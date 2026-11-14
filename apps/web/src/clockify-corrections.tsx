import { clockifyCorrectionTargetsPath, parseClockifyCorrectionTargetsResponse } from '@timekeeper/contracts';
import type { ClockifyCorrectionCandidate, ClockifyImportReviewBody, ClockifyImportReviewResponse, ClockifyPreviewRow, ClockifySource } from '@timekeeper/contracts';
import { useEffect, useId, useRef, useState } from 'react';
import type { SubmitEvent } from 'react';
import { readApi } from './api';
import { useSession } from './auth';
import { formatDuration, StockholmTime } from './entry-display';
import { formatSek } from './money';

export type CorrectionDecision = NonNullable<ClockifyImportReviewBody['rows'][number]['correction']>;
type CorrectionReview = NonNullable<ClockifyImportReviewResponse['rows'][number]['correction']>;
type CorrectionMode = '' | CorrectionDecision['mode'];
export interface CorrectionDraft { mode: CorrectionMode; target?: ClockifyCorrectionCandidate; confirmOverlap?: boolean }

export function correctionDecision(draft?: CorrectionDraft): CorrectionDecision | undefined {
	if (draft?.mode === 'separate') return { mode: 'separate' };
	if ((draft?.mode === 'keep' || draft?.mode === 'update') && draft.target) {
		return {
			mode: draft.mode, entryId: draft.target.entryId, revision: draft.target.revision,
			...(draft.mode === 'update' && draft.confirmOverlap ? { confirmOverlap: true } : {}),
		};
	}
	return undefined;
}

export function isIncompleteCorrection(draft?: CorrectionDraft) {
	return (draft?.mode === 'keep' || draft?.mode === 'update') && !draft.target;
}

const stateText: Record<ClockifyCorrectionCandidate['state'], string> = {
	active: 'Active',
	incomplete: 'Incomplete',
	invoiced: 'Invoiced',
	deleted: 'Deleted',
	split: 'Split original',
};

const updateRestriction: Partial<Record<ClockifyCorrectionCandidate['state'], string>> = {
	incomplete: 'Complete the saved entry before updating it.',
	invoiced: 'Unmark the saved invoice before updating this entry.',
	deleted: 'Restore this entry before updating it.',
	split: 'This source was split. Keep the saved lineage or import the incoming row separately.',
};

function candidateLabel(target: ClockifyCorrectionCandidate) {
	return (target.description || 'Untitled entry') + ' · ' + target.localDate + ' · ' + stateText[target.state];
}

function SourceValue({ source, other }: { source: ClockifySource; other?: ClockifySource }) {
	const timeChanged = other && (
		source.startDate !== other.startDate || source.startTime !== other.startTime ||
		source.endDate !== other.endDate || source.endTime !== other.endTime || source.durationH !== other.durationH
	);
	return (
		<>
			<dl>
				<div><dt>Description</dt><dd>{source.description || '—'}</dd></div>
				{timeChanged ? <div><dt>Source interval</dt><dd>{source.startDate} {source.startTime} to {source.endDate} {source.endTime} · {source.durationH || '—'}</dd></div> : null}
			</dl>
			<details className="clockify-correction-metadata">
				<summary>Source fields</summary>
				<dl>
					<div><dt>Start</dt><dd>{source.startDate} {source.startTime}</dd></div>
					<div><dt>End</dt><dd>{source.endDate} {source.endTime}</dd></div>
					<div><dt>Duration (h)</dt><dd>{source.durationH || '—'}</dd></div>
					<div><dt>Client and project</dt><dd>{source.client || 'No client'} · {source.project || 'No project'}</dd></div>
					<div><dt>Tags</dt><dd>{source.tags || '—'}</dd></div>
					<div><dt>Task and group</dt><dd>{source.task || '—'} · {source.group || '—'}</dd></div>
					<div><dt>User and email</dt><dd>{source.user || '—'} · {source.email || '—'}</dd></div>
					<div><dt>Date of creation</dt><dd>{source.dateOfCreation || '—'}</dd></div>
					<div><dt>Duration (decimal)</dt><dd>{source.durationDecimal || '—'}</dd></div>
				</dl>
			</details>
		</>
	);
}

type WorkValue = Pick<ClockifyCorrectionCandidate, 'description' | 'localDate' | 'startAt' | 'endAt' | 'durationSeconds' | 'amountOre'>;

function WorkSnapshot({ work, billing }: { work: WorkValue; billing?: ClockifyCorrectionCandidate }) {
	return (
		<dl>
			<div><dt>Description</dt><dd>{work.description || '—'}</dd></div>
			<div><dt>Work time (Stockholm)</dt><dd>{work.startAt && work.endAt ? (
				<><StockholmTime instant={work.startAt} /> to <StockholmTime instant={work.endAt} /></>
			) : <time dateTime={work.localDate}>{work.localDate}</time>}</dd></div>
			<div><dt>Duration and amount</dt><dd>{formatDuration(work.durationSeconds)} · {work.amountOre === null ? 'Incomplete' : formatSek(work.amountOre)}</dd></div>
			{billing ? (
				<>
					<div><dt>Billing</dt><dd>{billing.billable
						? billing.rateOrePerHour === null ? 'Billable · Missing rate' : 'Billable · ' + formatSek(billing.rateOrePerHour) + '/h'
						: 'Non-billable'}</dd></div>
					<div><dt>Client and project</dt><dd>{billing.clientName ?? 'No client'} · {billing.projectName ?? 'No project'}</dd></div>
				</>
			) : null}
		</dl>
	);
}

function TargetSearch({ onSelect, disabled }: { onSelect: (target: ClockifyCorrectionCandidate) => void; disabled: boolean }) {
	const { refresh } = useSession();
	const id = useId();
	const [draft, setDraft] = useState('');
	const [lastSearch, setLastSearch] = useState('');
	const [targets, setTargets] = useState<ClockifyCorrectionCandidate[]>([]);
	const [cursor, setCursor] = useState<string | null>(null);
	const [searched, setSearched] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState('');
	const active = useRef<AbortController | null>(null);
	useEffect(() => () => active.current?.abort(), []);

	async function load(search: string, next?: string) {
		if (active.current || disabled) return;
		const controller = new AbortController();
		active.current = controller;
		setBusy(true);
		setError('');
		if (!next) {
			setTargets([]);
			setCursor(null);
			setSearched(false);
			setLastSearch(search);
		}
		try {
			const query = new URLSearchParams(search ? { search } : {});
			if (next) query.set('cursor', next);
			const suffix = query.size ? '?' + query : '';
			const response = await readApi(clockifyCorrectionTargetsPath + suffix, parseClockifyCorrectionTargetsResponse,
				AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]), refresh);
			if (controller.signal.aborted) return;
			setTargets((previous) => next ? [...previous, ...response.candidates] : response.candidates);
			setCursor(response.nextCursor);
			setSearched(true);
		} catch {
			if (!controller.signal.aborted) setError('Could not load imported entries. Try the search again.');
		} finally {
			active.current = null;
			if (!controller.signal.aborted) setBusy(false);
		}
	}

	function search(event: SubmitEvent<HTMLFormElement>) {
		event.preventDefault();
		void load(draft.trim());
	}

	return (
		<div className="clockify-target-search">
			<form className="record-editor" onSubmit={search}>
				<div className="field">
					<label htmlFor={id}>Search imported entries</label>
					<input id={id} type="search" maxLength={160} value={draft} disabled={disabled}
						onChange={(event) => setDraft(event.target.value)} />
				</div>
				<div className="form-actions">
					<button type="submit" disabled={busy || disabled}>{busy ? 'Searching…' : 'Search imported entries'}</button>
				</div>
			</form>
			{error ? <p className="feedback error" role="alert">{error}</p> : null}
			{searched && !targets.length ? <p className="field-hint" role="status">No imported entries found.</p> : null}
			{targets.length ? (
				<ul className="clockify-rows">
					{targets.map((target) => (
						<li key={target.entryId} className="clockify-row">
							<button type="button" disabled={disabled} onClick={() => onSelect(target)}>Choose {candidateLabel(target)} · {target.entryId.slice(0, 8)}</button>
						</li>
					))}
				</ul>
			) : null}
			{cursor ? <button type="button" disabled={disabled || busy} onClick={() => void load(lastSearch, cursor)}>Load more matches</button> : null}
		</div>
	);
}

export function ClockifyCorrectionFields({ row, review, draft, onChange, disabled = false }: {
	row: ClockifyPreviewRow;
	review?: CorrectionReview | null;
	draft?: CorrectionDraft;
	onChange: (draft: CorrectionDraft) => void;
	disabled?: boolean;
}) {
	const id = useId();
	const candidates = review?.candidates ?? [];
	const candidateLabels = new Map<string, string>();
	for (const target of candidates) {
		const short = target.entryId.slice(0, 8);
		candidateLabels.set(target.entryId, candidateLabel(target) + ' · ' +
			(candidates.some((other) => other.entryId !== target.entryId && other.entryId.startsWith(short)) ? target.entryId : short));
	}
	const selected = draft ? draft.target : review?.selected ?? undefined;
	const current = review?.selected;
	const reviewedTarget = selected && current?.entryId === selected.entryId && current.revision === selected.revision ? current : undefined;
	const shown = reviewedTarget ?? selected ?? (candidates.length === 1 ? candidates[0] : undefined);
	const mode = draft?.mode ?? '';
	const problem = shown && updateRestriction[shown.state];
	const changedTarget = !!current && current.entryId === selected?.entryId && current.revision !== selected.revision;
	const proposed = mode === 'update' && reviewedTarget ? review?.proposed : undefined;

	function changeTarget(target?: ClockifyCorrectionCandidate) {
		onChange({ target, mode: mode === 'update' && target?.state !== 'active' ? '' : mode });
	}

	return (
		<div className="clockify-correction-fields record-editor" role="group" aria-label={'Correction for line ' + row.line}>
			{review?.candidateCount ? (
				<p className="field-hint">Possible matches share source user and timestamps. Check the details before choosing an entry.
					{review.candidateCount > candidates.length ? ' Search imported entries to see more matches.' : ''}</p>
			) : null}
			{candidates.length ? (
				<div className="field">
					<label htmlFor={id + '-target'}>Possible matching entry</label>
					<select id={id + '-target'} disabled={disabled} value={selected?.entryId ?? ''} onChange={(event) => {
						changeTarget(candidates.find((target) => target.entryId === event.target.value));
					}}>
						<option value="">Choose an entry</option>
						{selected && !candidates.some((target) => target.entryId === selected.entryId)
							? <option value={selected.entryId}>{candidateLabel(selected)} · {selected.entryId.slice(0, 8)}</option> : null}
						{candidates.map((target) => <option key={target.entryId} value={target.entryId}>
							{candidateLabels.get(target.entryId)}
						</option>)}
					</select>
				</div>
			) : null}
			<details>
				<summary>Find another imported entry</summary>
				<TargetSearch onSelect={changeTarget} disabled={disabled} />
			</details>
			{selected ? <p className="field-hint">Selected entry · {candidateLabel(selected)} · {selected.entryId.slice(0, 8)}</p> : null}
			{changedTarget ? <button type="button" disabled={disabled} onClick={() => changeTarget(current)}>Use current saved entry</button> : null}
			{problem ? <p className="field-hint">{problem}</p> : null}
			<div className="field">
				<label htmlFor={id + '-action'}>Correction action</label>
				<select id={id + '-action'} value={mode} disabled={disabled} onChange={(event) => {
					onChange({ target: selected, mode: event.target.value as CorrectionMode });
				}}>
					<option value="">Choose an action</option>
					<option value="keep" disabled={!selected}>Keep existing entry</option>
					<option value="update" disabled={!selected || selected.state !== 'active'}>Update existing entry</option>
					<option value="separate">Import as separate entry</option>
				</select>
			</div>
			{mode === 'keep' || mode === 'update' ? <p className="field-hint">
				{mode === 'keep' ? 'Keep the saved entry and remember this incoming row.'
					: 'Keep the saved client, project, rate, billability, and invoice status. A duration change recalculates the amount.'}
			</p> : null}
			{row.source && (shown || review) ? (
				<div className="clockify-correction-comparison">
					<section><h4>Incoming Clockify row</h4><SourceValue source={row.source} other={shown?.source} /></section>
					{shown ? (
						<>
							<section><h4>Compared Clockify row</h4><SourceValue source={shown.source} other={row.source} /></section>
							<section><h4>Current saved entry</h4><WorkSnapshot work={shown} billing={shown} /></section>
						</>
					) : null}
					{proposed ? <section><h4>Proposed update</h4><WorkSnapshot work={proposed} /></section> : null}
				</div>
			) : null}
			{mode === 'update' && proposed?.overlap ? (
				<label className="catalog-checkbox"><input type="checkbox" checked={draft?.confirmOverlap ?? false} disabled={disabled}
					onChange={(event) => onChange({ ...draft, mode, confirmOverlap: event.target.checked })} /> Approve overlapping time</label>
			) : null}
		</div>
	);
}
