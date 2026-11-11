import { maxCatalogNameLength, maxCatalogNotesLength } from '@timekeeper/contracts';
import type { ClientResponse, CreateClientBody, CreateProjectBody } from '@timekeeper/contracts';
import { useId, useState } from 'react';
import type { SubmitEvent } from 'react';
import { ApiRequestError, writeApi } from './api';
import { useSession } from './auth';
import {
	catalogPaths,
	describeCatalogError,
} from './catalog';
import type { CatalogKind, CatalogRecord } from './catalog';
import { formatHourlyRate, parseHourlyRate, rateInputValue } from './money';

interface CatalogEditorProps {
	kind: CatalogKind;
	record: CatalogRecord | null;
	clients: readonly ClientResponse[];
	onClose: () => void;
	onSaved: () => void;
	onReload: () => Promise<boolean>;
	onClientUnavailable: () => Promise<unknown>;
}

export function CatalogEditor({ kind, record, clients, onClose, onSaved, onReload, onClientUnavailable }: CatalogEditorProps) {
	const { session, refresh } = useSession();
	const project = record && 'clientId' in record ? record : null;
	const rate = project ? project.rateOverrideOrePerHour : record && 'defaultRateOrePerHour' in record
		? record.defaultRateOrePerHour
		: null;
	const [clientId, setClientId] = useState(project?.clientId ?? '');
	const [pending, setPending] = useState(false);
	const [error, setError] = useState('');
	const [conflict, setConflict] = useState(false);
	const [duplicate, setDuplicate] = useState<CreateClientBody | CreateProjectBody | null>(null);
	const nameId = useId();
	const notesId = useId();
	const rateId = useId();
	const clientIdInput = useId();
	const billableId = useId();
	const selectedClient = clients.find((client) => client.id === clientId);
	const eligibleClients = clients.filter((client) => !client.archivedAt || client.id === project?.clientId);
	const unavailableClient = !!clientId && !eligibleClients.some((client) => client.id === clientId);
	const inheritedRate = selectedClient?.defaultRateOrePerHour ?? null;
	const duplicateCode = kind === 'client' ? 'DUPLICATE_CLIENT_NAME' : 'DUPLICATE_PROJECT_NAME';

	async function save(body: CreateClientBody | CreateProjectBody, confirmDuplicate = false) {
		if (pending) return;
		setPending(true);
		setError('');
		setDuplicate(null);
		const path = catalogPaths[kind];
		try {
			await writeApi(
				record ? `${path}/${record.id}` : path,
				record ? 'PUT' : 'POST',
				session.csrfToken,
				{
					...body,
					...(record ? { revision: record.revision } : {}),
					...(confirmDuplicate ? { confirmDuplicate: true } : {}),
				},
			);
			onSaved();
		} catch (cause) {
			if (cause instanceof ApiRequestError && cause.code === duplicateCode) {
				setDuplicate(body);
			} else {
				if (cause instanceof ApiRequestError && cause.code === 'REVISION_CONFLICT') {
					setConflict(true);
				}
				if (cause instanceof ApiRequestError && cause.code === 'INVALID_CLIENT') {
					await onClientUnavailable();
				}
				setError(await describeCatalogError(cause, refresh, `Could not save the ${kind}. Check your connection and try again.`));
			}
		} finally {
			setPending(false);
		}
	}

	function submit(event: SubmitEvent<HTMLFormElement>) {
		event.preventDefault();
		const fields = new FormData(event.currentTarget);
		const name = String(fields.get('name')).trim();
		const notes = String(fields.get('notes')).trim() || null;
		if (!name || Array.from(name).length > maxCatalogNameLength) {
			setError(`Enter a name with 1 to ${maxCatalogNameLength} characters.`);
			const input = event.currentTarget.elements.namedItem('name');
			if (input instanceof HTMLInputElement) input.focus();
			return;
		}
		if (notes && Array.from(notes).length > maxCatalogNotesLength) {
			setError(`Keep notes to ${maxCatalogNotesLength.toLocaleString('en')} characters or fewer.`);
			return;
		}
		if (unavailableClient) {
			setError('Choose an active client or leave the project without a client.');
			return;
		}
		let rate: string | null;
		try {
			rate = parseHourlyRate(String(fields.get('rate')));
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : 'Enter a valid hourly rate.');
			return;
		}
		if (kind === 'client') {
			void save({ name, notes, defaultRateOrePerHour: rate });
		} else {
			void save({ name, notes, clientId: clientId || null, rateOverrideOrePerHour: rate, defaultBillable: fields.has('defaultBillable') });
		}
	}

	async function reload() {
		setPending(true);
		try {
			if (!await onReload()) {
				setError('Could not reload the saved details. Check your connection and try again.');
			}
		} finally {
			setPending(false);
		}
	}

	return (
		<form className="panel record-editor" onSubmit={submit} onChange={() => { if (duplicate) setDuplicate(null); }} aria-busy={pending}>
			<h2>{record ? `Edit ${kind}` : `New ${kind}`}</h2>
			{error ? <p role="alert" className="feedback error">{error}</p> : null}
			<fieldset disabled={pending} className="record-fields">
				<div className="field">
					<label htmlFor={nameId}>Name</label>
					<input id={nameId} name="name" defaultValue={record?.name} required autoFocus />
				</div>
				{kind === 'project' ? (
					<div className="field">
						<label htmlFor={clientIdInput}>Client</label>
						<select id={clientIdInput} value={clientId} onChange={(event) => setClientId(event.target.value)}>
							<option value="">No client</option>
							{unavailableClient ? <option value={clientId} disabled>{selectedClient?.name ?? 'Selected client'} (unavailable)</option> : null}
							{eligibleClients.map((client) => (
								<option key={client.id} value={client.id}>
									{client.name}{client.archivedAt ? ' (archived)' : ''}
								</option>
							))}
						</select>
					</div>
				) : null}
				<div className="field">
					<label htmlFor={rateId}>{kind === 'client' ? 'Default hourly rate (SEK)' : 'Hourly rate override (SEK)'}</label>
					<input id={rateId} name="rate" inputMode="decimal" defaultValue={rateInputValue(rate)} aria-describedby={`${rateId}-hint`} />
					<p id={`${rateId}-hint`} className="field-hint">
						{kind === 'client' ? 'Optional. Enter 0 for a zero rate.' : (
							inheritedRate === null || unavailableClient ? 'Leave blank if there is no default hourly rate. Enter 0 to set a zero rate.'
								: `Leave blank to inherit ${formatHourlyRate(inheritedRate)}. Enter 0 to override it with zero.`
						)}
					</p>
				</div>
				{kind === 'project' ? (
					<label className="catalog-checkbox" htmlFor={billableId}>
						<input id={billableId} name="defaultBillable" type="checkbox" defaultChecked={project?.defaultBillable ?? true} />
						Billable by default
					</label>
				) : null}
				<div className="field">
					<label htmlFor={notesId}>Notes</label>
					<textarea id={notesId} name="notes" rows={3} defaultValue={record?.notes ?? ''} />
				</div>
			</fieldset>
			{duplicate ? (
				<div className="feedback warning">
					<p role="alert">
						{kind === 'client' ? 'A client with this name already exists.' : (
							clientId ? 'A project with this name already exists for this client.'
								: 'A project with this name already exists without a client.'
						)}
						{' '}Change the name or save it as a separate record.
					</p>
					<button type="button" onClick={() => void save(duplicate, true)} disabled={pending}>Save as separate {kind}</button>
				</div>
			) : null}
			<div className="form-actions">
				{conflict ? (
					<button className="primary" type="button" onClick={() => void reload()} disabled={pending}>Reload saved details</button>
				) : (
					<button className="primary" type="submit" disabled={pending || !!duplicate}>
						{pending ? 'Saving…' : record ? 'Save changes' : `Create ${kind}`}
					</button>
				)}
				<button type="button" onClick={onClose} disabled={pending}>Cancel</button>
			</div>
		</form>
	);
}
