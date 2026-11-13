import { useLayoutEffect, useRef, useState } from 'react';
import type { LocalTimeOccurrence } from '@timekeeper/contracts';
import { displayClock, formatDurationInput, parseClockInput, parseDurationInput, resolveBoundary } from './entry-time';
import type { EntryBoundary } from './entry-time';

interface TimeInputProps {
	id: string;
	label: string;
	kind: 'clock' | 'duration';
	value: string;
	error?: string;
	hint?: string;
	submitted?: boolean;
	onChange: (value: string) => void;
}

export function TimeInput({ id, label, kind, value, error, hint, submitted, onChange }: TimeInputProps) {
	const [focused, setFocused] = useState(false);
	const [editing, setEditing] = useState(false);
	const input = useRef<HTMLInputElement>(null);
	const clock = kind === 'clock' ? parseClockInput(value) : null;
	const seconds = kind === 'duration' ? parseDurationInput(value) : null;
	const formatted = clock ? displayClock(clock) : seconds !== null ? formatDurationInput(seconds) : null;
	const visibleValue = focused
		? !editing && formatted ? formatted.replaceAll(':', '') : value
		: formatted ?? value;
	const message = submitted ? error : undefined;

	useLayoutEffect(() => {
		if (focused) input.current?.select();
	}, [focused]);

	return (
		<div className="field">
			<label htmlFor={id}>{label}</label>
			<input
				id={id}
				ref={input}
				type="text"
				inputMode="numeric"
				autoComplete="off"
				spellCheck={false}
				className="entry-clock"
				value={visibleValue}
				aria-required="true"
				aria-invalid={message ? true : undefined}
				aria-describedby={[hint && id + '-hint', message && id + '-error'].filter(Boolean).join(' ') || undefined}
				onFocus={() => setFocused(true)}
				onBlur={() => { setFocused(false); setEditing(false); }}
				onChange={(event) => { setEditing(true); onChange(event.target.value); }}
			/>
			{hint ? <p className="field-hint" id={id + '-hint'}>{hint}</p> : null}
			{message ? <p className="entry-field-error" id={id + '-error'}>{message}</p> : null}
		</div>
	);
}

export function EntryDateField({ id, label, value, error, onChange }: {
	id: string;
	label: string;
	value: string;
	error?: string;
	onChange: (value: string) => void;
}) {
	return (
		<div className="field">
			<label htmlFor={id}>{label}</label>
			<input
				id={id}
				type="date"
				min="0001-01-01"
				max="9999-12-31"
				aria-required="true"
				aria-invalid={error ? true : undefined}
				aria-describedby={error ? id + '-error' : undefined}
				value={value}
				onChange={(event) => onChange(event.target.value)}
			/>
			{error ? <p className="entry-field-error" id={id + '-error'}>{error}</p> : null}
		</div>
	);
}

export function OccurrenceField({ id, label, choices, value, error, onChange }: {
	id: string;
	label: string;
	choices: NonNullable<ReturnType<typeof resolveBoundary>['choices']>;
	value: EntryBoundary['occurrence'];
	error?: string;
	onChange: (value: EntryBoundary['occurrence']) => void;
}) {
	return (
		<div className="field">
			<label htmlFor={id}>{label}</label>
			<select
				id={id}
				value={value ?? ''}
				aria-required="true"
				aria-invalid={error ? true : undefined}
				aria-describedby={error ? id + '-error' : undefined}
				onChange={(event) => onChange((event.target.value || undefined) as LocalTimeOccurrence | undefined)}
			>
				<option value="">Choose an occurrence</option>
				<option value="earlier">First (UTC{choices.earlier.offset})</option>
				<option value="later">Second (UTC{choices.later.offset})</option>
			</select>
			{error ? <p className="entry-field-error" id={id + '-error'}>{error}</p> : null}
		</div>
	);
}
