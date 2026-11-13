import { useQuery } from '@tanstack/react-query';
import type { EntryResponse } from '@timekeeper/contracts';
import { clientsPath, parseClientListResponse, parseProjectListResponse, projectsPath } from '@timekeeper/contracts';
import { useId, useState } from 'react';
import { readApi } from './api';
import { useSession } from './auth';
import { catalogKey } from './catalog';
import { formatSek } from './money';

export function entryAssociation(entry?: EntryResponse) {
	if (entry?.projectId) return 'project:' + entry.projectId;
	if (entry?.directClientId) return 'client:' + entry.directClientId;
	return '';
}

export function useEntryBilling(entry?: EntryResponse) {
	const { refresh } = useSession();
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
	const [association, setAssociation] = useState(() => entryAssociation(entry));
	const [billability, setBillability] = useState(() => entry ? entry.billable ? 'billable' : 'non-billable' : '');
	const project = projects.data?.find((item) => association === `project:${item.id}`);
	const client = clients.data?.find((item) => association === `client:${item.id}`);
	const clientById = new Map(clients.data?.map((item) => [item.id, item]));
	const originalAssociation = entryAssociation(entry);
	const retainedAssociation = !!entry && association === originalAssociation;
	const archived = retainedAssociation && !!association && !project && !client;
	const unavailable = !!association && !project && !client && !retainedAssociation;
	const defaultRate = project?.effectiveRateOrePerHour ?? client?.defaultRateOrePerHour ?? null;
	const defaultBillable = project?.defaultBillable ?? !!client;
	const canChoose = clients.data !== undefined && projects.data !== undefined;
	const choicesError = clients.isError || projects.isError;
	function reloadChoices() {
		return Promise.all([clients.refetch(), projects.refetch()]);
	}

	return {
		clients, projects, clientById, association, setAssociation, billability, setBillability, canChoose,
		unavailable, defaultBillable, defaultRate, choicesError, reloadChoices, archived,
		projectId: project?.id ?? (retainedAssociation ? entry.projectId : null),
		directClientId: client?.id ?? (retainedAssociation ? entry.directClientId : null),
	};
}

export function EntryBillingFields({ billing, entry, rateMode, onRateModeChange }: {
	billing: ReturnType<typeof useEntryBilling>;
	entry?: EntryResponse;
	rateMode?: 'keep' | 'current' | 'override';
	onRateModeChange?: (mode: 'keep' | 'current' | 'override') => void;
}) {
	const id = useId();
	const {
		clients, projects, clientById, association, setAssociation, billability, setBillability, canChoose,
		unavailable, defaultBillable, defaultRate, choicesError, reloadChoices, archived,
	} = billing;
	return (
		<>
			<div className="field">
				<label htmlFor={`${id}-association`}>Association</label>
				<select id={`${id}-association`} value={association} disabled={!canChoose}
					onChange={(event) => {
						setAssociation(event.target.value);
						onRateModeChange?.('keep');
					}}
				>
					<option value="">No client or project</option>
					{archived ? <option value={association}>{entry?.projectName ?? entry?.clientName ?? 'Saved association'} (archived)</option> : null}
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
					{entry ? null : <option value="">Use default ({defaultBillable ? 'billable' : 'non-billable'})</option>}
					<option value="billable">Billable</option>
					<option value="non-billable">Non-billable</option>
				</select>
			</div>
			{entry && onRateModeChange ? (
				<div className="field">
					<label htmlFor={`${id}-rate-mode`}>Hourly rate</label>
					<select id={`${id}-rate-mode`} value={rateMode}
						onChange={(event) => onRateModeChange(event.target.value as 'keep' | 'current' | 'override')}>
						<option value="keep">Keep saved rate ({entry.assignedRateOrePerHour === null ? 'no rate' : formatSek(entry.assignedRateOrePerHour) + '/hour'})</option>
						<option value="current" disabled={archived}>Use current default ({defaultRate === null ? 'no rate' : formatSek(defaultRate) + '/hour'})</option>
						<option value="override">Enter a different rate</option>
					</select>
				</div>
			) : null}
			{!entry || rateMode === 'override' ? (
				<div className="field">
					<label htmlFor={`${id}-rate`}>Hourly rate override (SEK)</label>
					<input id={`${id}-rate`} name="rate" inputMode="decimal" aria-describedby={`${id}-rate-hint`} />
					<p className="field-hint" id={`${id}-rate-hint`}>
						{entry ? 'Enter a rate in SEK. Zero is accepted.' : defaultRate === null
							? 'No default rate. Enter a rate for billable work, including 0 if applicable.'
							: `Leave blank to use ${formatSek(defaultRate)}/hour. Enter 0 to override it with zero.`}
					</p>
				</div>
			) : null}

		</>
	);
}
