import {
	entriesPath,
	maxEntryDescriptionLength,
	entryTimeZone,
	formatStockholmLocalTime,
	parseEntryResponse,
	parseEntryEditPreview,
} from '@timekeeper/contracts';
import type { CreateDurationEntryBody, CreateTimedEntryBody, EntryEditBody, EntryEditPreview, EntryEditTime, EntryResponse } from '@timekeeper/contracts';
import { useEffect, useId, useRef, useState } from 'react';
import type { SubmitEvent } from 'react';
import { flushSync } from 'react-dom';
import { ApiRequestError, readApi, writeApi } from './api';
import { authError, useSession } from './auth';
import { entryAssociation, EntryBillingFields, useEntryBilling } from './entry-billing-fields';
import { boundaryFromInstant, calculateTiming, durationError, formatDurationInput, parseDurationInput, updateBoundary } from './entry-time';
import type { EntryBoundary, TimingDraft } from './entry-time';
import { EntryDateField, OccurrenceField, TimeInput } from './entry-time-fields';
import { formatSek, parseHourlyRate } from './money';

const stockholmDate = new Intl.DateTimeFormat('sv-SE', {
	timeZone: entryTimeZone,
	year: 'numeric',
	month: '2-digit',
	day: '2-digit',
});

function todayInStockholm() {
	return stockholmDate.format(new Date());
}

interface EntryEditorProps {
	onClose: () => void;
	onSaved: (entry: EntryResponse) => void;
	entry?: EntryResponse;
}

function toLocal(boundary: EntryBoundary) {
	const time = boundary.time.length === 5 ? boundary.time + ':00' : boundary.time;
	return boundary.date + 'T' + time;
}

function displayBoundary(instant: string) {
	const { local, offset } = formatStockholmLocalTime(instant);
	return local.replace('T', ' ') + ' (UTC' + offset + ')';
}

function sameTiming(time: EntryEditTime, current: EntryResponse) {
	if (time.kind === 'duration-only') {
		return current.kind === 'duration-only' && current.localDate === time.localDate && current.durationSeconds === time.durationSeconds;
	}
	if (current.kind !== 'timed') return false;
	const start = boundaryFromInstant(current.startAt);
	const end = boundaryFromInstant(current.endAt);
	return toLocal(start) === time.startLocal && toLocal(end) === time.endLocal &&
		start.occurrence === time.startOccurrence && end.occurrence === time.endOccurrence;
}

export function EntryEditor({ onClose, onSaved, entry }: EntryEditorProps) {
	const { session, refresh } = useSession();
	const [baseline, setBaseline] = useState(entry);
	const billing = useEntryBilling(baseline);
	const path = baseline ? `${entriesPath}/${encodeURIComponent(baseline.id)}` : entriesPath;
	const [rateMode, setRateMode] = useState<NonNullable<EntryEditBody['rate']>['mode']>('keep');
	const [preview, setPreview] = useState<{ body: EntryEditBody; value: EntryEditPreview } | null>(null);
	const [stale, setStale] = useState(false);
	const [latest, setLatest] = useState<EntryResponse | null>(null);
	const [locked, setLocked] = useState(!!entry?.invoicedAt);
	const previewHeading = useRef<HTMLHeadingElement>(null);
	const latestHeading = useRef<HTMLHeadingElement>(null);
	useEffect(() => { if (preview) previewHeading.current?.focus(); }, [preview]);
	useEffect(() => { if (latest) latestHeading.current?.focus(); }, [latest]);
	const { canChoose, unavailable, billability, reloadChoices, projectId, directClientId } = billing;
	const [pending, setPending] = useState(false);
	const [error, setError] = useState('');
	const [mode, setMode] = useState<'duration-only' | 'timed'>(entry?.kind ?? 'duration-only');
	const [workDate, setWorkDate] = useState(() => entry?.localDate ?? todayInStockholm());
	const [workDuration, setWorkDuration] = useState(() => entry?.durationSeconds ? formatDurationInput(entry.durationSeconds) : '');
	const [timingDraft, setTimingDraft] = useState<TimingDraft>(() => {
		if (entry?.kind === 'timed') {
			return { start: boundaryFromInstant(entry.startAt), end: boundaryFromInstant(entry.endAt), duration: '', anchor: 'end' };
		}
		const date = entry?.localDate ?? todayInStockholm();
		return { start: { date, time: '' }, end: { date, time: '' }, duration: '', anchor: entry ? 'end' : 'duration' };
	});
	const [submitted, setSubmitted] = useState(false);
	const [overlap, setOverlap] = useState<CreateTimedEntryBody | null>(null);
	const timing = mode === 'timed' ? calculateTiming(timingDraft) : null;
	const workDurationError = durationError(workDuration);
	const visibleEnd = timing && timingDraft.anchor === 'duration' && !timing.end.date
		? { ...timing.end, date: timingDraft.start.date }
		: timing?.end;
	const id = useId();

	function changeStart(change: Partial<EntryBoundary>) {
		setTimingDraft((draft) => ({ ...draft, start: updateBoundary(draft.start, change) }));
	}

	function changeEnd(end: EntryBoundary, change: Partial<EntryBoundary>) {
		setTimingDraft((draft) => ({ ...draft, anchor: 'end', end: updateBoundary(end, change) }));
	}

	function changeDuration(duration: string) {
		setTimingDraft((draft) => ({ ...draft, anchor: 'duration', duration }));
	}

	async function describeSaveError(cause: unknown) {
		if (!(cause instanceof ApiRequestError)) {
			return 'Could not confirm the time entry was saved. Check the list before trying again.';
		}
		if (cause.response.status === 401 || cause.response.status === 403) {
			return authError(cause.response, refresh);
		}
		switch (cause.code) {
			case 'REVISION_CONFLICT':
				setStale(true);
				setLatest(null);
				return 'This entry changed in another session. Review the latest version before saving your draft.';
			case 'ENTRY_DEFAULT_RATE_CHANGED':
				setRateMode('keep');
				await reloadChoices();
				return 'The current default rate changed. Choose the rate and preview your changes again.';
			case 'ENTRY_INVOICED':
				setLocked(true);
				return 'This entry is invoiced. Unmark it before editing.';
			case 'INVALID_PROJECT':
			case 'INVALID_CLIENT':
			case 'INVALID_ASSOCIATION':
				await reloadChoices();
				return 'The selected association is unavailable. Choose an active project or client, or leave it unassigned.';
			case 'INVALID_LOCAL_DATE':
				return 'Enter a valid work date.';
			case 'INVALID_LOCAL_TIME':
				return 'Check the start and end date and time.';
			case 'NONEXISTENT_LOCAL_TIME':
				return 'One of the times does not exist in Stockholm on its date. Choose another time.';
			case 'AMBIGUOUS_LOCAL_TIME':
				return 'Choose which occurrence of the repeated Stockholm time you mean.';
			case 'INVALID_TIME_RANGE':
				return 'End must be after start.';
			case 'INVALID_DURATION':
				return 'Check that the duration is positive and within the supported range.';
			case 'INVALID_DESCRIPTION':
				return `Enter a description up to ${maxEntryDescriptionLength.toLocaleString('en')} characters.`;
			case 'MISSING_HOURLY_RATE':
				return 'Enter an hourly rate or choose Non-billable.';
			case 'INVALID_HOURLY_RATE':
				return 'Enter an hourly rate in SEK within the supported range.';
			case 'AMOUNT_OUT_OF_RANGE':
				return 'The billable amount is too large. Shorten the duration or lower the hourly rate.';
			case 'INVALID_REQUEST':
				return 'Check the date, duration and other values and try again.';
			default:
				return 'Could not confirm the time entry was saved. Check the list before trying again.';
		}
	}

	async function save(body: CreateDurationEntryBody | CreateTimedEntryBody) {
		setPending(true);
		setError('');
		try {
			const response = await writeApi(entriesPath, 'POST', session.csrfToken, body);
			onSaved(parseEntryResponse(await response.json()));
		} catch (cause) {
			if (body.kind === 'timed' && cause instanceof ApiRequestError && cause.code === 'ENTRY_OVERLAP') {
				setOverlap(body);
			} else {
				setOverlap(null);
				setError(await describeSaveError(cause));
			}
		} finally {
			setPending(false);
		}
	}

	async function previewEdit(body: EntryEditBody) {
		setPending(true);
		setError('');
		try {
			const response = await writeApi(path + '/edit-preview', 'POST', session.csrfToken, body, { signal: AbortSignal.timeout(10_000) });
			setPreview({ body, value: parseEntryEditPreview(await response.json()) });
		} catch (cause) {
			setError(await describeSaveError(cause));
		} finally {
			setPending(false);
		}
	}

	async function saveEdit(draft: NonNullable<typeof preview>) {
		if (pending || stale || locked) return;
		setPending(true);
		setError('');
		try {
			const response = await writeApi(path, 'PUT', session.csrfToken, {
				...draft.body, ...(draft.value.overlap ? { confirmOverlap: true } : {}),
			}, { signal: AbortSignal.timeout(10_000) });
			onSaved(parseEntryResponse(await response.json()));
		} catch (cause) {
			setPreview(null);
			if (cause instanceof ApiRequestError && cause.code === 'ENTRY_OVERLAP') {
				setError('Another timed entry now overlaps this work. Preview again to review the overlap.');
			} else {
				setError(await describeSaveError(cause));
			}
		} finally {
			setPending(false);
		}
	}

	async function reviewLatest() {
		setPending(true);
		setError('');
		try {
			const current = await readApi(path, parseEntryResponse, AbortSignal.timeout(10_000), refresh);
			setLatest(current);
			if (current.invoicedAt) setLocked(true);
		} catch (cause) {
			setError(await describeSaveError(cause));
		} finally {
			setPending(false);
		}
	}

	function submit(event: SubmitEvent<HTMLFormElement>) {
		event.preventDefault();
		if (pending || !canChoose || stale || locked || preview) return;
		const formElement = event.currentTarget;
		const form = new FormData(formElement);
		const description = String(form.get('description')).trim();
		if (!description || Array.from(description).length > maxEntryDescriptionLength) {
			setError(`Enter a description up to ${maxEntryDescriptionLength.toLocaleString('en')} characters.`);
			return;
		}
		if (unavailable) {
			setError('Choose an active project or client, or leave the time entry unassigned.');
			return;
		}

		setError('');
		setOverlap(null);
		const durationSeconds = parseDurationInput(workDuration);
		const entryTime: EntryEditTime | null = timing
			? timing.start.instant && timing.start.local && timing.endResolution.instant && timing.endResolution.local &&
				!timing.rangeError && !timing.durationError
				? {
					kind: 'timed' as const,
					startLocal: timing.start.local,
					endLocal: timing.endResolution.local,
					...(timing.start.choices ? { startOccurrence: timingDraft.start.occurrence } : {}),
					...(timing.endResolution.choices ? { endOccurrence: timing.end.occurrence } : {}),
				}
				: null
			: workDate && !workDurationError && durationSeconds !== null
				? { kind: 'duration-only' as const, localDate: workDate, durationSeconds }
				: null;

		if (!entryTime) {
			flushSync(() => setSubmitted(true));
			formElement.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
			return;
		}
		setSubmitted(true);

		if (baseline) {
			let rate: EntryEditBody['rate'] = { mode: 'keep' };
			if (rateMode === 'current') {
				rate = { mode: 'current', expectedDefaultRateOrePerHour: billing.defaultRate };
			} else if (rateMode === 'override') {
				try {
					const rateOrePerHour = parseHourlyRate(String(form.get('rate')));
					if (rateOrePerHour === null) throw new Error('Enter a rate or choose Keep saved rate.');
					rate = { mode: 'override', rateOrePerHour };
				} catch (cause) {
					setError(cause instanceof Error ? cause.message : 'Check the hourly rate.');
					return;
				}
			}
			void previewEdit({
				revision: baseline.revision, description, projectId, directClientId, billable: billability === 'billable',
				rate, ...(sameTiming(entryTime, baseline) ? {} : { time: entryTime }),
			});
			return;
		}

		let rateOverrideOrePerHour: string | null;
		try {
			rateOverrideOrePerHour = parseHourlyRate(String(form.get('rate')));
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : 'Check the hourly rate.');
			return;
		}
		void save({
			...entryTime,
			description,
			projectId,
			directClientId,
			rateOverrideOrePerHour,
			...(billability ? { billable: billability === 'billable' } : {}),
		});
	}

	return (
		<form className="panel record-editor" onSubmit={submit} onChange={() => { setOverlap(null); setPreview(null); }} aria-busy={pending}>
			<h2>{baseline ? 'Edit time entry' : 'New time entry'}</h2>
			{error ? <p className="feedback error" role="alert">{error}</p> : null}
			<fieldset disabled={pending || locked} className="record-fields">
				<div className="field">
					<label htmlFor={`${id}-description`}>Description</label>
					<textarea id={`${id}-description`} name="description" rows={2} required autoFocus defaultValue={entry?.description} />
				</div>
				<fieldset className="entry-type">
					<legend>Entry type</legend>
					<div className="entry-type-options">
						<label>
							<input type="radio" name="entryType" checked={mode === 'duration-only'}
								onChange={() => { setMode('duration-only'); setSubmitted(false); setError(''); }} />
							Duration only
						</label>
						<label>
							<input type="radio" name="entryType" checked={mode === 'timed'}
								onChange={() => { setMode('timed'); setSubmitted(false); setError(''); }} />
							Timed
						</label>
					</div>
				</fieldset>
				{timing && visibleEnd ? (
					<div className="entry-timing">
						<p className="field-hint"><strong>Stockholm time</strong></p>
						<div className="entry-time-fields">
							<EntryDateField id={`${id}-start-date`} label="Start date" value={timingDraft.start.date}
								error={submitted ? timing.start.dateError : undefined} onChange={(date) => changeStart({ date })} />
							<div className="entry-time-boundary">
								<TimeInput id={`${id}-start-time`} label="Start time" kind="clock" value={timingDraft.start.time}
									submitted={submitted} error={timing.start.timeError}
									hint="24-hour time, e.g. 0900 or 09:00."
									onChange={(time) => changeStart({ time })} />
								{timing.start.choices ? (
									<OccurrenceField id={`${id}-start-occurrence`} label="Start time occurrence"
										choices={timing.start.choices} value={timingDraft.start.occurrence}
										error={submitted ? timing.start.occurrenceError : undefined}
										onChange={(occurrence) => changeStart({ occurrence })} />
								) : null}
							</div>
							<EntryDateField id={`${id}-end-date`} label="End date" value={visibleEnd.date}
								error={submitted ? timing.endResolution.dateError : undefined}
								onChange={(date) => changeEnd(visibleEnd, { date })} />
							<div className="entry-time-boundary">
								<TimeInput id={`${id}-end-time`} label="End time" kind="clock" value={timing.end.time}
									submitted={submitted} error={timing.endResolution.timeError ?? timing.rangeError}
									onChange={(time) => changeEnd(visibleEnd, { time })} />
								{timing.endResolution.choices ? (
									<OccurrenceField id={`${id}-end-occurrence`} label="End time occurrence"
										choices={timing.endResolution.choices} value={timing.end.occurrence}
										error={submitted ? timing.endResolution.occurrenceError : undefined}
										onChange={(occurrence) => changeEnd(timing.end, { occurrence })} />
								) : null}
							</div>
							<TimeInput id={`${id}-timed-duration`} label="Duration" kind="duration" value={timing.duration}
								submitted={submitted} error={timing.durationError}
								hint="Hours, minutes and seconds, e.g. 3000 or 00:30:00."
								onChange={changeDuration} />
						</div>
						<div className="entry-timing-hints">
							<p className="field-hint">Edit duration to move the end. Edit the end to recalculate duration.</p>
							<p className="field-hint">Changing the start keeps {timingDraft.anchor === 'end' ? 'the end' : 'the duration'}.</p>
						</div>
					</div>
				) : (
					<div className="entry-timing entry-time-fields">
						<EntryDateField id={`${id}-date`} label="Work date" value={workDate}
							error={submitted && !workDate ? 'Enter a work date.' : undefined} onChange={setWorkDate} />
						<TimeInput id={`${id}-duration`} label="Duration" kind="duration" value={workDuration}
							submitted={submitted} error={workDurationError}
							hint="Hours, minutes and seconds, e.g. 3000 or 00:30:00."
							onChange={setWorkDuration} />
					</div>
				)}

				<EntryBillingFields billing={billing} entry={baseline} rateMode={rateMode} onRateModeChange={setRateMode} />
			</fieldset>
			{stale ? (
				<div className="feedback warning">
					{latest ? (
						<>
							<h3 className="entry-completion-heading" tabIndex={-1} ref={latestHeading}>Latest saved entry</h3>
							<p><strong>{latest.description || 'Untitled time entry'}</strong></p>
							<p>{latest.kind === 'timed'
								? `${displayBoundary(latest.startAt)} to ${displayBoundary(latest.endAt)}`
								: latest.localDate} · {formatDurationInput(latest.durationSeconds)}</p>
							<p>{[latest.projectName, latest.clientName].filter(Boolean).join(' · ') || 'No client or project'} · {latest.billable ? 'Billable' : 'Non-billable'}</p>
							<p>{latest.assignedRateOrePerHour === null ? 'No hourly rate' : `${formatSek(latest.assignedRateOrePerHour)}/hour`}</p>
							<p>{latest.billableAmountOre === null ? 'Incomplete' : formatSek(latest.billableAmountOre)}</p>
							{latest.invoicedAt ? <p>This entry is invoiced. Unmark it before editing.</p> : (
								<>
									<p>Compare the saved details with your draft above. Keeping the draft lets you preview it against this saved version.</p>
									<button type="button" disabled={pending} onClick={() => {
										if (billing.association !== entryAssociation(latest)) setRateMode('keep');
										setBaseline(latest);
										setLatest(null);
										setStale(false);
										setError('');
									}}>Keep draft for review</button>
								</>
							)}
						</>
					) : <button type="button" disabled={pending} onClick={() => void reviewLatest()}>Review latest entry</button>}
				</div>
			) : null}
			{baseline && preview ? (
				<div className="entry-edit-preview">
					<h3 className="entry-completion-heading" tabIndex={-1} ref={previewHeading}>Review changes</h3>
					<dl className="entry-edit-comparison">
						<div><dt>Duration</dt><dd>{formatDurationInput(baseline.durationSeconds)} → {formatDurationInput(preview.value.durationSeconds)}</dd></div>
						<div><dt>Billable amount</dt><dd>{baseline.billableAmountOre === null ? 'Incomplete' : formatSek(baseline.billableAmountOre)} → {formatSek(preview.value.billableAmountOre)}</dd></div>
						<div><dt>Hourly rate</dt><dd>{preview.value.assignedRateOrePerHour === null ? 'No rate' : formatSek(preview.value.assignedRateOrePerHour) + '/hour'}</dd></div>
					</dl>
					{preview.value.overlap ? <p className="feedback warning">This time overlaps another timed entry.</p> : null}
					<button className="primary" type="button" disabled={pending || stale || locked}
						onClick={() => void saveEdit(preview)}>{pending ? 'Saving…' : preview.value.overlap ? 'Save changes with overlap' : 'Save changes'}</button>
				</div>
			) : null}

			{overlap ? (
				<div className="feedback warning">
					<p role="alert">This time overlaps another timed entry. You can save it anyway.</p>
					<button type="button" disabled={pending || !canChoose}
						onClick={() => void save({ ...overlap, confirmOverlap: true })}>
						Save overlapping entry
					</button>
				</div>
			) : null}
			<div className="form-actions">
				{!preview ? <button className="primary" type="submit" disabled={pending || !canChoose || stale || locked}>
					{baseline ? pending ? 'Checking…' : 'Preview changes' : pending ? 'Saving…' : 'Save time entry'}
				</button> : null}
				<button type="button" onClick={onClose} disabled={pending}>Cancel</button>
			</div>
		</form>
	);
}
