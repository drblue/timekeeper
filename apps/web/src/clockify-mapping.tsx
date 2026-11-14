import { maxCatalogNameLength } from '@timekeeper/contracts';
import type { ClockifyImportAssociation } from '@timekeeper/contracts';
import { useId } from 'react';
import { clockifyCatalogLabels, suggestClockifyMatch } from './clockify-catalog';
import type { ClockifyCatalog } from './clockify-catalog';

type Choice = ClockifyImportAssociation['client'];
export type Mapping = { client: string; clientName: string; project: string; projectName: string };
export const emptyMapping: Mapping = { client: '', clientName: '', project: '', projectName: '' };

export function suggestedMapping(client: string, project: string, catalog: ClockifyCatalog): Mapping {
	const clientId = suggestClockifyMatch(client, catalog.clients);
	const projectId = clientId || !client.trim()
		? suggestClockifyMatch(project, catalog.projects.filter((item) => item.clientId === (clientId ?? null)))
		: undefined;
	return {
		client: clientId ?? (client.trim() ? '' : 'none'), clientName: client.trim(),
		project: projectId ?? (project.trim() ? '' : 'none'), projectName: project.trim(),
	};
}

export function mappingChoice(mapping: Mapping, catalog: ClockifyCatalog): ClockifyImportAssociation | undefined {
	function choice(value: string, name: string, items: ClockifyCatalog['clients'] | ClockifyCatalog['projects']): Choice | undefined {
		if (value === 'none') return { mode: 'none' };
		if (value === 'create' && name.trim()) return { mode: 'create', name: name.trim() };
		const existing = items.find((item) => item.id === value);
		return existing ? { mode: 'existing', id: existing.id, revision: existing.revision } : undefined;
	}
	const client = choice(mapping.client, mapping.clientName, catalog.clients);
	const project = choice(mapping.project, mapping.projectName, catalog.projects);
	return client && project ? { client, project } : undefined;
}

export function ClockifyMapping({ mapping, onChange, catalog, label }: {
	mapping: Mapping;
	onChange: (next: Mapping) => void;
	catalog: ClockifyCatalog;
	label: string;
}) {
	const id = useId();
	const projects = mapping.client === 'create' || !mapping.client ? []
		: catalog.projects.filter((project) => project.clientId === (mapping.client === 'none' ? null : mapping.client));
	const clientLabel = clockifyCatalogLabels(catalog.clients);
	const projectLabel = clockifyCatalogLabels(projects);
	return (
		<div className="clockify-mapping-fields" role="group" aria-label={label}>
			<div className="field">
				<label htmlFor={id + '-client'}>Client</label>
				<select id={id + '-client'} value={mapping.client} onChange={(event) => {
					onChange({ ...mapping, client: event.target.value,
						project: mapping.project === 'none' || mapping.project === 'create' ? mapping.project : '' });
				}}>
					<option value="">Choose client</option>
					<option value="none">No client</option>
					{catalog.clients.map((item) => <option value={item.id} key={item.id}>{clientLabel(item.name, item.id)}</option>)}
					<option value="create">Create client</option>
				</select>
			</div>
			{mapping.client === 'create' ? (
				<div className="field">
					<label htmlFor={id + '-client-name'}>New client name</label>
					<input id={id + '-client-name'} maxLength={maxCatalogNameLength} value={mapping.clientName}
						onChange={(event) => onChange({ ...mapping, clientName: event.target.value })} />
				</div>
			) : null}
			<div className="field">
				<label htmlFor={id + '-project'}>Project</label>
				<select id={id + '-project'} value={mapping.project} onChange={(event) => onChange({ ...mapping, project: event.target.value })}>
					<option value="">Choose project</option>
					<option value="none">No project</option>
					{projects.map((item) => <option value={item.id} key={item.id}>{projectLabel(item.name, item.id)}</option>)}
					<option value="create">Create project</option>
				</select>
			</div>
			{mapping.project === 'create' ? (
				<div className="field">
					<label htmlFor={id + '-project-name'}>New project name</label>
					<input id={id + '-project-name'} maxLength={maxCatalogNameLength} value={mapping.projectName}
						onChange={(event) => onChange({ ...mapping, projectName: event.target.value })} />
				</div>
			) : null}
		</div>
	);
}
