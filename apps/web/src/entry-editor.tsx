import { useQuery } from '@tanstack/react-query';
import {
	clientsPath,
	entriesPath,
	maxEntryDescriptionLength,
	entryTimeZone,
	parseClientListResponse,
	parseEntryResponse,
	parseProjectListResponse,
	projectsPath,
} from '@timekeeper/contracts';
import type { CreateDurationEntryBody, CreateTimedEntryBody, EntryResponse } from '@timekeeper/contracts';
import { useId, useState } from 'react';
import type { SubmitEvent } from 'react';
import { flushSync } from 'react-dom';
import { ApiRequestError, readApi, writeApi } from './api';
import { authError, useSession } from './auth';
import { catalogKey } from './catalog';
import { calculateTiming, durationError, parseDurationInput, updateBoundary } from './entry-time';
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
}

export function EntryEditor({ onClose, onSaved }: EntryEditorProps) {
	const { session, refresh } = useSession();
	const clients = useQuery({
		queryKey: [...catalogKey, 'active', 'clients'],
		queryFn: ({ signal }) => readApi(clientsPath, parseClientListResponse, signal, refresh),
		networkMode: 'always',
		retry: false,
	});
	const projects = useQuery({
		queryKey: [...catalogKey, 'active', 'projects'],
		queryFn: ({ signal }) => readApi(projectsPath, parseProjectListResponse, signal, refresh),
		networkMode: 'always',
		retry: false,
	});
	const [association, setAssociation] = useState('');
	const [billability, setBillability] = useState('');
	const [pending, setPending] = useState(false);
	const [error, setError] = useState('');
	const [mode, setMode] = useState<'duration-only' | 'timed'>('duration-only');
	const [workDate, setWorkDate] = useState(todayInStockholm);
	const [workDuration, setWorkDuration] = useState('');
	const [timingDraft, setTimingDraft] = useState<TimingDraft>(() => {
		const date = todayInStockholm();
		return { start: { date, time: '' }, end: { date, time: '' }, duration: '', anchor: 'duration' };
	});
	const [submitted, setSubmitted] = useState(false);
	const [overlap, setOverlap] = useState<CreateTimedEntryBody | null>(null);
	const timing = mode === 'timed' ? calculateTiming(timingDraft) : null;
	const workDurationError = durationError(workDuration);
	const visibleEnd = timing && timingDraft.anchor === 'duration' && !timing.end.date
		? { ...timing.end, date: timingDraft.start.date }
		: timing?.end;
	const id = useId();
	const project = projects.data?.find((item) => association === `project:${item.id}`);
	const client = clients.data?.find((item) => association === `client:${item.id}`);
	const clientById = new Map(clients.data?.map((item) => [item.id, item]));
	const unavailable = !!association && !project && !client;
	const defaultRate = project?.effectiveRateOrePerHour ?? client?.defaultRateOrePerHour ?? null;
	const defaultBillable = project?.defaultBillable ?? !!client;
	const canChoose = clients.data !== undefined && projects.data !== undefined;
	const choicesError = clients.isError || projects.isError;

	function changeStart(change: Partial<EntryBoundary>) {
		setTimingDraft((draft) => ({ ...draft, start: updateBoundary(draft.start, change) }));
	}

	function changeEnd(end: EntryBoundary, change: Partial<EntryBoundary>) {
		setTimingDraft((draft) => ({ ...draft, anchor: 'end', end: updateBoundary(end, change) }));
	}

	function changeDuration(duration: string) {
		setTimingDraft((draft) => ({ ...draft, anchor: 'duration', duration }));
	}

	function reloadChoices() {
		return Promise.all([clients.refetch(), projects.refetch()]);
	}

	async function describeSaveError(cause: unknown) {
		if (!(cause instanceof ApiRequestError)) {
			return 'Could not confirm the time entry was saved. Check the list before trying again.';
		}
		if (cause.response.status === 401 || cause.response.status === 403) {
			return authError(cause.response, refresh);
		}
		switch (cause.code) {
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

	function submit(event: SubmitEvent<HTMLFormElement>) {
		event.preventDefault();
		if (pending || !canChoose) return;
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
		const entryTime = timing
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
			projectId: project?.id ?? null,
			directClientId: client?.id ?? null,
			rateOverrideOrePerHour,
			...(billability ? { billable: billability === 'billable' } : {}),
		});
	}

	return (
		<form className="panel record-editor" onSubmit={submit} onChange={() => setOverlap(null)} aria-busy={pending}>
			<h2>New time entry</h2>
			{error ? <p className="feedback error" role="alert">{error}</p> : null}
			<fieldset disabled={pending} className="record-fields">
				<div className="field">
					<label htmlFor={`${id}-description`}>Description</label>
					<textarea id={`${id}-description`} name="description" rows={2} required autoFocus />
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

				<div className="field">
					<label htmlFor={`${id}-association`}>Association</label>
					<select id={`${id}-association`} value={association} disabled={!canChoose}
						onChange={(event) => setAssociation(event.target.value)}
					>
						<option value="">No client or project</option>
						{unavailable ? <option value={association} disabled>Selected association unavailable</option> : null}
						{projects.data?.length ? (
							<optgroup label="Projects">
								{projects.data.map((item) => {
									const projectClient = item.clientId ? clientById.get(item.clientId) : undefined;
									return <option key={item.id} value={`project:${item.id}`}>{item.name} ({projectClient?.name ?? 'no client'})</option>;
								})}
							</optgroup>
						) : null}
						{clients.data?.length ? (
							<optgroup label="Direct clients">
								{clients.data.map((item) => <option key={item.id} value={`client:${item.id}`}>{item.name}</option>)}
							</optgroup>
						) : null}
					</select>
					{choicesError ? (
						<div className="feedback error catalog-load-error">
							<p role="alert">Could not load project and client choices.</p>
							<button type="button" onClick={() => void reloadChoices()} disabled={clients.isFetching || projects.isFetching}>Try again</button>
						</div>
					) : !canChoose ? <p className="field-hint" role="status">Loading project and client choices…</p> : null}
				</div>
				<div className="field">
					<label htmlFor={`${id}-billability`}>Billability</label>
					<select id={`${id}-billability`} value={billability} onChange={(event) => setBillability(event.target.value)}>
						<option value="">Use default ({defaultBillable ? 'billable' : 'non-billable'})</option>
						<option value="billable">Billable</option>
						<option value="non-billable">Non-billable</option>
					</select>
				</div>
				<div className="field">
					<label htmlFor={`${id}-rate`}>Hourly rate override (SEK)</label>
					<input id={`${id}-rate`} name="rate" inputMode="decimal" aria-describedby={`${id}-rate-hint`} />
					<p className="field-hint" id={`${id}-rate-hint`}>
						{defaultRate === null
							? 'No default rate. Enter a rate for billable work, including 0 if applicable.'
							: `Leave blank to use ${formatSek(defaultRate)}/hour. Enter 0 to override it with zero.`}
					</p>
				</div>
			</fieldset>
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
				<button className="primary" type="submit" disabled={pending || !canChoose}>{pending ? 'Saving…' : 'Save time entry'}</button>
				<button type="button" onClick={onClose} disabled={pending}>Cancel</button>
			</div>
		</form>
	);
}
