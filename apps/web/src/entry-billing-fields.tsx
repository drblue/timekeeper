import { useQuery } from '@tanstack/react-query';
import { clientsPath, parseClientListResponse, parseProjectListResponse, projectsPath } from '@timekeeper/contracts';
import { useId, useState } from 'react';
import { readApi } from './api';
import { useSession } from './auth';
import { catalogKey } from './catalog';
import { formatSek } from './money';

export function useEntryBilling() {
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
	const [association, setAssociation] = useState('');
	const [billability, setBillability] = useState('');
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

	return {
		clients, projects, clientById, association, setAssociation, billability, setBillability, canChoose,
		unavailable, defaultBillable, defaultRate, choicesError, reloadChoices,
		projectId: project?.id ?? null,
		directClientId: client?.id ?? null,
	};
}

export function EntryBillingFields({ billing }: { billing: ReturnType<typeof useEntryBilling> }) {
	const id = useId();
	const {
		clients, projects, clientById, association, setAssociation, billability, setBillability, canChoose,
		unavailable, defaultBillable, defaultRate, choicesError, reloadChoices,
	} = billing;
	return (
		<>
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
		</>
	);
}
