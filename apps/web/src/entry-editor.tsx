import { useQuery } from '@tanstack/react-query';
import {
	clientsPath,
	entriesPath,
	maxEntryDescriptionLength,
	maxEntryDurationSeconds,
	parseClientListResponse,
	parseDurationEntryResponse,
	parseProjectListResponse,
	projectsPath,
} from '@timekeeper/contracts';
import type { CreateDurationEntryBody, DurationEntryResponse } from '@timekeeper/contracts';
import { useId, useState } from 'react';
import type { SubmitEvent } from 'react';
import { ApiRequestError, readApi, writeApi } from './api';
import { authError, useSession } from './auth';
import { catalogKey } from './catalog';
import { formatSek, parseHourlyRate } from './money';

const stockholmDate = new Intl.DateTimeFormat('sv-SE', {
	timeZone: 'Europe/Stockholm',
	year: 'numeric',
	month: '2-digit',
	day: '2-digit',
});

function todayInStockholm() {
	return stockholmDate.format(new Date());
}

function parseDuration(hours: string, minutes: string): number {
	const digits = /^\d{0,10}$/;
	if (!digits.test(hours) || !digits.test(minutes)) {
		throw new Error('Enter whole hours and minutes.');
	}
	const seconds = Number(hours) * 3600 + Number(minutes) * 60;
	if (seconds <= 0) {
		throw new Error('Enter a duration of at least one minute.');
	}
	if (seconds > maxEntryDurationSeconds) {
		throw new Error('Enter a shorter duration.');
	}
	return seconds;
}

interface EntryEditorProps {
	onClose: () => void;
	onSaved: (entry: DurationEntryResponse) => void;
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
	const id = useId();
	const project = projects.data?.find((item) => association === `project:${item.id}`);
	const client = clients.data?.find((item) => association === `client:${item.id}`);
	const clientById = new Map(clients.data?.map((item) => [item.id, item]));
	const unavailable = !!association && !project && !client;
	const defaultRate = project?.effectiveRateOrePerHour ?? client?.defaultRateOrePerHour ?? null;
	const defaultBillable = project?.defaultBillable ?? !!client;
	const canChoose = clients.data !== undefined && projects.data !== undefined;
	const choicesError = clients.isError || projects.isError;

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

	async function submit(event: SubmitEvent<HTMLFormElement>) {
		event.preventDefault();
		if (pending || !canChoose) return;
		const form = new FormData(event.currentTarget);
		const description = String(form.get('description')).trim();
		const localDate = String(form.get('localDate'));
		if (!description || Array.from(description).length > maxEntryDescriptionLength) {
			setError(`Enter a description up to ${maxEntryDescriptionLength.toLocaleString('en')} characters.`);
			return;
		}
		if (unavailable) {
			setError('Choose an active project or client, or leave the time entry unassigned.');
			return;
		}

		let durationSeconds: number;
		let rateOverrideOrePerHour: string | null;
		try {
			durationSeconds = parseDuration(String(form.get('hours')).trim(), String(form.get('minutes')).trim());
			rateOverrideOrePerHour = parseHourlyRate(String(form.get('rate')));
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : 'Check the duration and hourly rate.');
			return;
		}

		const body: CreateDurationEntryBody = {
			kind: 'duration-only',
			description,
			localDate,
			durationSeconds,
			projectId: project?.id ?? null,
			directClientId: client?.id ?? null,
			rateOverrideOrePerHour,
			...(billability ? { billable: billability === 'billable' } : {}),
		};
		setPending(true);
		setError('');
		try {
			const response = await writeApi(entriesPath, 'POST', session.csrfToken, body);
			onSaved(parseDurationEntryResponse(await response.json()));
		} catch (cause) {
			setError(await describeSaveError(cause));
		} finally {
			setPending(false);
		}
	}

	return (
		<form className="panel record-editor" onSubmit={(event) => void submit(event)} aria-busy={pending}>
			<h2>New time entry</h2>
			{error ? <p className="feedback error" role="alert">{error}</p> : null}
			<fieldset disabled={pending} className="record-fields">
				<div className="field">
					<label htmlFor={`${id}-description`}>Description</label>
					<textarea id={`${id}-description`} name="description" rows={2} required autoFocus />
				</div>
				<div className="entry-time-fields">
					<div className="field">
						<label htmlFor={`${id}-date`}>Work date</label>
						<input id={`${id}-date`} name="localDate" type="date" defaultValue={todayInStockholm()} required />
					</div>
					<fieldset className="entry-duration">
						<legend>Duration</legend>
						<div className="entry-duration-inputs">
							<div className="field">
								<label htmlFor={`${id}-hours`}>Hours</label>
								<input id={`${id}-hours`} name="hours" inputMode="numeric" placeholder="0" />
							</div>
							<div className="field">
								<label htmlFor={`${id}-minutes`}>Minutes</label>
								<input id={`${id}-minutes`} name="minutes" inputMode="numeric" placeholder="0" />
							</div>
						</div>
					</fieldset>
				</div>
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
			<div className="form-actions">
				<button className="primary" type="submit" disabled={pending || !canChoose}>{pending ? 'Saving…' : 'Save time entry'}</button>
				<button type="button" onClick={onClose} disabled={pending}>Cancel</button>
			</div>
		</form>
	);
}
