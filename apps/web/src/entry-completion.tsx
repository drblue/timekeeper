import { useId, useState } from 'react';
import type { SubmitEvent } from 'react';
import { flushSync } from 'react-dom';
import { entriesPath, maxEntryDescriptionLength, parseEntryResponse } from '@timekeeper/contracts';
import type { EntryResponse, IncompleteEntryResponse } from '@timekeeper/contracts';
import { ApiRequestError, writeApi } from './api';
import { authError, useSession } from './auth';
import { durationError, parseDurationInput } from './entry-time';
import { TimeInput } from './entry-time-fields';
import { formatSek, parseHourlyRate } from './money';

export function EntryCompletion({ entry, onSaved, onRefresh }: {
	entry: IncompleteEntryResponse;
	onSaved: (entry: EntryResponse) => void;
	onRefresh: () => void;
}) {
	const { session, refresh } = useSession();
	const id = useId();
	const [revision] = useState(entry.revision);
	const [description, setDescription] = useState(entry.description);
	const [billable, setBillable] = useState(entry.billable);
	const [rate, setRate] = useState('');
	const [duration, setDuration] = useState('');
	const [submitted, setSubmitted] = useState(false);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState('');
	const hasConflict = entry.revision !== revision;
	const needsDuration = entry.missingFields.includes('duration');
	const durationMessage = needsDuration ? durationError(duration) : undefined;

	async function submit(event: SubmitEvent<HTMLFormElement>) {
		event.preventDefault();
		if (pending || hasConflict) return;
		setError('');
		const text = description.trim();
		if (!text || Array.from(text).length > maxEntryDescriptionLength) {
			setError(`Enter a description up to ${maxEntryDescriptionLength.toLocaleString('en')} characters.`);
			return;
		}
		if (durationMessage) {
			flushSync(() => setSubmitted(true));
			event.currentTarget.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
			return;
		}
		const seconds = needsDuration ? parseDurationInput(duration) : null;
		let rateOverrideOrePerHour: string | null;
		try {
			rateOverrideOrePerHour = billable ? parseHourlyRate(rate) : null;
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : 'Check the hourly rate.');
			return;
		}
		setPending(true);
		try {
			const response = await writeApi(`${entriesPath}/${encodeURIComponent(entry.id)}/complete`, 'POST', session.csrfToken, {
				revision, description: text, billable, rateOverrideOrePerHour,
				...(seconds === null ? {} : { durationSeconds: seconds }),
			}, { signal: AbortSignal.timeout(10_000) });
			onSaved(parseEntryResponse(await response.json()));
		} catch (cause) {
			if (cause instanceof ApiRequestError) {
				if (cause.response.status === 401 || cause.response.status === 403) {
					setError(await authError(cause.response, refresh));
				} else if (cause.code === 'REVISION_CONFLICT' || cause.code === 'ENTRY_ALREADY_COMPLETE') {
					setError('This entry changed in another session. Check the saved entry before trying again.');
					onRefresh();
				} else if (cause.code === 'MISSING_HOURLY_RATE') {
					setError('Enter an hourly rate or choose Non-billable.');
				} else if (cause.code === 'AMOUNT_OUT_OF_RANGE') {
					setError('The billable amount is too large. Lower the hourly rate or choose Non-billable.');
				} else {
					setError('Check the details and try again.');
				}
			} else {
				setError('Could not confirm completion. Check the saved entry before trying again.');
			}
		} finally {
			setPending(false);
		}
	}

	return (
		<form className="panel record-editor" onSubmit={(event) => void submit(event)} aria-busy={pending}>
			<h2 className="entry-completion-heading">Complete time entry</h2>
			{hasConflict ? <p className="feedback warning" role="alert">This entry changed. Reload to start again with its current details.</p> : null}
			{error ? <p className="feedback error" role="alert">{error}</p> : null}
			<fieldset className="record-fields" disabled={pending}>
				<div className="field">
					<label htmlFor={id + '-description'}>Description</label>
					<textarea id={id + '-description'} rows={2} required value={description}
						onChange={(event) => setDescription(event.target.value)} />
				</div>
				{needsDuration ? (
					<TimeInput id={id + '-duration'} label="Duration" kind="duration" value={duration} error={durationMessage}
						submitted={submitted} hint="Enter the time worked, e.g. 3000 or 00:30:00." onChange={setDuration} />
				) : null}
				<div className="field">
					<label htmlFor={id + '-billability'}>Billability</label>
					<select id={id + '-billability'} value={billable ? 'billable' : 'non-billable'}
						onChange={(event) => setBillable(event.target.value === 'billable')}>
						<option value="billable">Billable</option>
						<option value="non-billable">Non-billable</option>
					</select>
				</div>
				{billable ? (
					<div className="field">
						<label htmlFor={id + '-rate'}>Hourly rate (SEK)</label>
						<input id={id + '-rate'} inputMode="decimal" value={rate} onChange={(event) => setRate(event.target.value)}
							aria-describedby={id + '-rate-hint'} />
						<p className="field-hint" id={id + '-rate-hint'}>{entry.assignedRateOrePerHour === null
							? 'Enter the agreed rate. Zero is accepted.'
							: `Leave blank to keep ${formatSek(entry.assignedRateOrePerHour)}/hour.`}</p>
					</div>
				) : null}
			</fieldset>
			<div className="form-actions">
				<button className="primary" type="submit" disabled={pending || hasConflict}>
					{pending ? 'Saving…' : 'Save completed entry'}
				</button>
				{error ? <button type="button" disabled={pending} onClick={onRefresh}>Check saved entry</button> : null}
			</div>
		</form>
	);
}
