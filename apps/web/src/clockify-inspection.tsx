import { getRouteApi, Link } from '@tanstack/react-router';
import { clockifyPreviewPath, csrfHeader, entryTimeZone, maxClockifyCsvBytes, maxClockifyRows, parseClockifyPreviewResponse } from '@timekeeper/contracts';
import type { ClockifyPreviewResponse } from '@timekeeper/contracts';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { SubmitEvent } from 'react';
import { ApiRequestError, requestError } from './api';
import { authError, useSession } from './auth';
import { ClockifyRows } from './clockify-rows';

const inspectionRoute = getRouteApi('/protected/imports/clockify');
const sourceZones = Intl.supportedValuesOf?.('timeZone') ?? [];
const suggestedZones = Array.from(new Set([entryTimeZone, 'UTC', ...sourceZones]));
type FocusField = 'file' | 'zone' | 'user' | 'results';

function uploadError(cause: unknown): { message: string; field: FocusField } {
	if (cause instanceof ApiRequestError) {
		switch (cause.code) {
			case 'CLOCKIFY_INVALID_ENCODING':
				return { field: 'file', message: 'Use a UTF-8 CSV exported from Clockify.' };
			case 'CLOCKIFY_UNSUPPORTED_HEADERS':
				return { field: 'file', message: 'This file does not have the required Clockify headers. Export a Detailed report as CSV and try again.' };
			case 'CLOCKIFY_MALFORMED_CSV':
				return { field: 'file', message: 'This CSV has invalid quoting or separators. Export it again from Clockify.' };
			case 'CLOCKIFY_EMPTY_CSV':
				return { field: 'file', message: 'This file contains no time entries. Choose an export with time entries.' };
			case 'CLOCKIFY_CSV_LIMIT':
				return { field: 'file', message: 'This file exceeds the inspection limit. Export a shorter date range.' };
			case 'CLOCKIFY_INVALID_TIME_ZONE':
				return { field: 'zone', message: 'Enter an IANA time zone such as Europe/Stockholm or UTC.' };
			case 'CLOCKIFY_UNKNOWN_USER':
				return { field: 'user', message: 'This user is no longer available. Choose a user listed for this file.' };
		}
		if (cause.response.status === 413) return { field: 'file', message: 'Choose a CSV file of 4 MiB or less.' };
		if (cause.response.status === 415) return { field: 'file', message: 'Choose a CSV exported from Clockify.' };
	}
	return { field: 'results', message: 'Could not inspect the file. Check your connection and try again.' };
}

function userLabel(user: ClockifyPreviewResponse['users'][number]) {
	return user.user && user.email ? user.user + ' · ' + user.email : user.user || user.email || 'Unnamed user';
}

export function ClockifyInspection() {
	const search = inspectionRoute.useSearch();
	const { session, refresh } = useSession();
	const [file, setFile] = useState<File>();
	const [zone, setZone] = useState<string>(entryTimeZone);
	const [user, setUser] = useState('');
	const [preview, setPreview] = useState<ClockifyPreviewResponse>();
	const [error, setError] = useState<{ message: string; field: FocusField }>();
	const [busy, setBusy] = useState(false);
	const heading = useRef<HTMLHeadingElement>(null);
	const resultHeading = useRef<HTMLHeadingElement>(null);
	const fileInput = useRef<HTMLInputElement>(null);
	const zoneInput = useRef<HTMLInputElement>(null);
	const userInput = useRef<HTMLSelectElement>(null);
	const errorMessage = useRef<HTMLParagraphElement>(null);
	const active = useRef<AbortController | null>(null);
	const focusAfter = useRef<FocusField | undefined>(undefined);
	const changed = !!preview && (zone.trim() !== preview.sourceTimeZone || user !== (preview.selectedUserId ?? ''));

	useLayoutEffect(() => heading.current?.focus(), []);
	useEffect(() => () => active.current?.abort(), []);
	useLayoutEffect(() => {
		if (busy) return;
		const target = focusAfter.current;
		focusAfter.current = undefined;
		if (target === 'file') fileInput.current?.focus();
		if (target === 'zone') zoneInput.current?.focus();
		if (target === 'user') userInput.current?.focus();
		if (target === 'results') (error ? errorMessage.current : resultHeading.current)?.focus();
	});

	function changeFile(next?: File) {
		setFile(next);
		setPreview(undefined);
		setUser('');
		setError(undefined);
	}

	async function inspect(event: SubmitEvent<HTMLFormElement>) {
		event.preventDefault();
		if (active.current || !file) return;
		if (file.size > maxClockifyCsvBytes || file.size === 0) {
			focusAfter.current = 'file';
			setError({ field: 'file', message: file.size === 0 ? 'Choose a CSV file that contains time entries.' : 'Choose a CSV file of 4 MiB or less.' });
			return;
		}
		if (!zone.trim()) {
			focusAfter.current = 'zone';
			setError({ field: 'zone', message: 'Enter the time zone used in the export.' });
			return;
		}
		if (preview && preview.users.length > 1 && !user) {
			focusAfter.current = 'user';
			setError({ field: 'user', message: 'Choose the user whose entries you want to inspect.' });
			return;
		}
		const query = new URLSearchParams({ sourceTimeZone: zone.trim() });
		if (user) query.set('selectedUserId', user);
		const controller = new AbortController();
		active.current = controller;
		setBusy(true);
		setError(undefined);
		try {
			const response = await fetch(clockifyPreviewPath + '?' + query, {
				method: 'POST',
				cache: 'no-store',
				headers: { [csrfHeader]: session.csrfToken, 'Content-Type': 'text/csv' },
				body: file,
				signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]),
			});
			if (!response.ok) throw await requestError(response);
			const next = parseClockifyPreviewResponse(await response.json());
			if (controller.signal.aborted) return;
			setPreview(next);
			setZone(next.sourceTimeZone);
			setUser(next.selectedUserId ?? '');
			focusAfter.current = next.requiresUserSelection ? 'user' : 'results';
		} catch (cause) {
			if (controller.signal.aborted) return;
			const failure = cause instanceof ApiRequestError && [401, 403].includes(cause.response.status)
				? { field: 'results' as const, message: await authError(cause.response, refresh) }
				: uploadError(cause);
			focusAfter.current = failure.field;
			setError(failure);
		} finally {
			active.current = null;
			if (!controller.signal.aborted) setBusy(false);
		}
	}

	const selected = preview?.users.find((candidate) => candidate.id === preview.selectedUserId);
	return (
		<section className="entry-page clockify-page" aria-labelledby="clockify-heading">
			<h1 id="clockify-heading" className="entry-heading" tabIndex={-1} ref={heading}>Inspect Clockify export</h1>
			<p className="field-hint">Review time entries from a Clockify Detailed report CSV before importing them.</p>
			<form className="panel record-editor" onSubmit={(event) => void inspect(event)} aria-busy={busy}>
				<div className="field">
					<label htmlFor="clockify-file">Clockify CSV file</label>
					<input id="clockify-file" ref={fileInput} type="file" accept=".csv,text/csv" disabled={busy}
						onChange={(event) => changeFile(event.target.files?.[0])}
						aria-invalid={error?.field === 'file' ? true : undefined}
						aria-describedby={error?.field === 'file' ? 'clockify-file-hint clockify-error' : 'clockify-file-hint'} />
					<p id="clockify-file-hint" className="field-hint">UTF-8 CSV, up to 4 MiB and {maxClockifyRows.toLocaleString('en-GB')} time entries.</p>
				</div>
				<div className="field clockify-zone">
					<label htmlFor="clockify-zone">Source time zone</label>
					<input id="clockify-zone" ref={zoneInput} list="clockify-zones" value={zone} disabled={busy}
						maxLength={128} autoComplete="off" spellCheck={false}
						onChange={(event) => { setZone(event.target.value); setError(undefined); }}
						aria-invalid={error?.field === 'zone' ? true : undefined}
						aria-describedby={error?.field === 'zone' ? 'clockify-zone-hint clockify-error' : 'clockify-zone-hint'} />
					<datalist id="clockify-zones">{suggestedZones.map((option) => <option key={option} value={option} />)}</datalist>
					<p id="clockify-zone-hint" className="field-hint">Use the time zone shown in Clockify when the CSV was exported.</p>
				</div>
				{preview && preview.users.length > 1 ? (
					<div className="field">
						<label htmlFor="clockify-user">Clockify user</label>
						<select id="clockify-user" ref={userInput} value={user} disabled={busy}
							onChange={(event) => { setUser(event.target.value); setError(undefined); }}
							aria-invalid={error?.field === 'user' ? true : undefined}
							aria-describedby={error?.field === 'user' ? 'clockify-user-hint clockify-error' : 'clockify-user-hint'}>
							<option value="">Choose a user</option>
							{preview.users.map((candidate) => (
								<option key={candidate.id} value={candidate.id}>{userLabel(candidate)} ({candidate.rowCount})</option>
							))}
						</select>
						<p id="clockify-user-hint" className="field-hint">This file contains {preview.users.length} users. Choose one to inspect.</p>
					</div>
				) : null}
				{error ? <p id="clockify-error" className="feedback error" ref={errorMessage} tabIndex={-1} role="alert">{error.message}</p> : null}
				{busy ? <p className="field-hint" role="status">Inspecting the CSV…</p> : null}
				<div className="form-actions">
					<button type="submit" className="primary" disabled={!file || busy}>{preview ? 'Inspect selection' : 'Inspect file'}</button>
					<Link className="action-link" to="/entries" search={search} state={{ clockifyInspectionReturned: true }}>Cancel inspection</Link>
				</div>
			</form>
			{preview && changed ? (
				<p className="feedback warning" role="status">Inspect the selection to see results for the new user or time zone.</p>
			) : null}
			{preview && !changed && !busy ? (
				<section className="panel report-section clockify-results" aria-labelledby="clockify-results-heading">
					<h2 id="clockify-results-heading" tabIndex={-1} ref={resultHeading}>Inspection results</h2>
					<p className="field-hint">
						{selected ? userLabel(selected) + ' · ' : ''}{preview.sourceTimeZone}
					</p>
					<dl className="clockify-counts">
						<div><dt>Rows in file</dt><dd>{preview.counts.total}</dd></div>
						<div><dt>Selected rows</dt><dd>{preview.counts.selected}</dd></div>
						<div><dt>Valid</dt><dd>{preview.counts.valid}</dd></div>
						<div><dt>Needs review</dt><dd>{preview.counts.review}</dd></div>
						<div><dt>Invalid</dt><dd>{preview.counts.invalid}</dd></div>
					</dl>
					{preview.counts.unassigned ? <p className="field-hint">{preview.counts.unassigned} invalid {preview.counts.unassigned === 1 ? 'row has' : 'rows have'} no identifiable user.</p> : null}
					{preview.requiresUserSelection ? <p>Choose a Clockify user above to inspect their time entries.</p> : null}
					{preview.rows.length ? <ClockifyRows key={preview.sourceTimeZone + ':' + preview.selectedUserId} rows={preview.rows} /> : null}
					<p className="field-hint">Inspection leaves your time entries, clients, and projects unchanged.</p>
				</section>
			) : null}
		</section>
	);
}
