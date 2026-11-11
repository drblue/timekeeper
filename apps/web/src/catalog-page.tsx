import { useQuery, useQueryClient } from '@tanstack/react-query';
import { parseClientListResponse, parseProjectListResponse } from '@timekeeper/contracts';
import type { ClientResponse } from '@timekeeper/contracts';
import { useRef, useState } from 'react';
import { ApiRequestError, writeApi } from './api';
import { useSession } from './auth';
import { CatalogEditor } from './catalog-editor';
import {
	catalogKey,
	catalogPaths,
	describeCatalogError,
	readCatalog,
} from './catalog';
import type { CatalogKind, CatalogRecord } from './catalog';
import { formatHourlyRate } from './money';

function RecordDetails({ record, client }: { record: CatalogRecord; client?: ClientResponse }) {
	if ('effectiveRateOrePerHour' in record) {
		const rate = record.effectiveRateOrePerHour;
		return (
			<div className="catalog-details">
				<p>{client ? `${client.name}${client.archivedAt ? ' (archived client)' : ''}` : 'No client'}</p>
				<p>{record.defaultBillable ? 'Billable by default' : 'Non-billable by default'}</p>
				<p>{rate === null ? 'No hourly rate' : (
					`${formatHourlyRate(rate)} (${record.rateOverrideOrePerHour === null ? 'inherited' : 'override'})`
				)}</p>
			</div>
		);
	}
	return (
		<div className="catalog-details">
			<p>{record.defaultRateOrePerHour === null ? 'No default hourly rate' : formatHourlyRate(record.defaultRateOrePerHour)}</p>
		</div>
	);
}

export function CatalogPage({ kind }: { kind: CatalogKind }) {
	const { session, refresh } = useSession();
	const queryClient = useQueryClient();
	const clients = useQuery({
		queryKey: [...catalogKey, 'client'],
		queryFn: ({ signal }) => readCatalog(catalogPaths.client, parseClientListResponse, signal, refresh),
		retry: false,
		networkMode: 'always',
	});
	const projects = useQuery({
		queryKey: [...catalogKey, 'project'],
		queryFn: ({ signal }) => readCatalog(catalogPaths.project, parseProjectListResponse, signal, refresh),
		enabled: kind === 'project',
		retry: false,
		networkMode: 'always',
	});
	const [showArchived, setShowArchived] = useState(false);
	const [editor, setEditor] = useState<{ record: CatalogRecord | null } | null>(null);
	const [pendingId, setPendingId] = useState<string | null>(null);
	const [feedback, setFeedback] = useState<{ message: string; error?: boolean } | null>(null);
	const editTrigger = useRef<HTMLButtonElement | null>(null);
	const archivedControl = useRef<HTMLInputElement>(null);
	const records = kind === 'client' ? clients.data : projects.data;
	const available = records !== undefined && clients.data !== undefined;
	const loadError = clients.isError || (kind === 'project' && projects.isError);
	const fetching = clients.isFetching || (kind === 'project' && projects.isFetching);
	const label = kind === 'client' ? 'Clients' : 'Projects';
	const clientById = new Map(clients.data?.map((client) => [client.id, client]));
	const visible = records?.filter((record) => showArchived || !record.archivedAt);

	function openEditor(record: CatalogRecord | null, trigger: HTMLButtonElement) {
		editTrigger.current = trigger;
		setFeedback(null);
		setEditor({ record });
	}

	function closeEditor() {
		setEditor(null);
		// The trigger is temporarily disabled while the editor is open.
		requestAnimationFrame(() => { editTrigger.current?.focus(); });
	}

	function saved() {
		setFeedback({ message: editor?.record ? `Changes to the ${kind} were saved.` : `The ${kind} was created.` });
		closeEditor();
		void queryClient.invalidateQueries({ queryKey: catalogKey });
	}

	async function reloadRecords() {
		const requests = kind === 'project' ? [clients.refetch(), projects.refetch()] : [clients.refetch()];
		await Promise.all(requests);
	}

	async function reloadEditor() {
		const current = editor?.record;
		if (!current) return false;
		const result = kind === 'client' ? await clients.refetch() : await projects.refetch();
		if (result.isError) return false;
		const latest = result.data?.find((record) => record.id === current.id);
		if (!latest) return false;
		setEditor({ record: latest });
		return true;
	}

	async function toggleArchive(record: CatalogRecord) {
		const action = record.archivedAt ? 'restore' : 'archive';
		setPendingId(record.id);
		setFeedback(null);
		try {
			await writeApi(`${catalogPaths[kind]}/${record.id}/${action}`, 'POST', session.csrfToken, { revision: record.revision });
			setFeedback({ message: `The ${kind} was ${action === 'archive' ? 'archived' : 'restored'}.` });
			if (action === 'archive' && !showArchived) {
				archivedControl.current?.focus();
			}
			await queryClient.invalidateQueries({ queryKey: catalogKey });
		} catch (cause) {
			if (cause instanceof ApiRequestError && cause.code === 'REVISION_CONFLICT') {
				await reloadRecords();
				setFeedback({ message: 'This record changed elsewhere. Check the current list and try again.', error: true });
			} else {
				setFeedback({
					message: await describeCatalogError(cause, refresh, `Could not ${action} the ${kind}. Check your connection and try again.`),
					error: true,
				});
			}
		} finally {
			setPendingId(null);
		}
	}

	return (
		<section className="catalog-page" aria-labelledby="catalog-heading">
			<div className="catalog-toolbar">
				<h1 id="catalog-heading">{label}</h1>
				<button
					type="button"
					className="primary"
					disabled={!available || !!editor || !!pendingId}
					onClick={(event) => openEditor(null, event.currentTarget)}
				>
					New {kind}
				</button>
			</div>
			{loadError ? (
				<div className="feedback error catalog-load-error">
					<p role="alert">Could not load {label.toLowerCase()}. Check your connection and try again.</p>
					<button type="button" onClick={() => void reloadRecords()} disabled={fetching}>Try again</button>
				</div>
			) : null}
			{feedback ? (
				<p className={feedback.error ? 'feedback error' : 'feedback'} role={feedback.error ? 'alert' : 'status'}>
					{feedback.message}
				</p>
			) : null}
			{editor && available ? (
				<CatalogEditor
					key={editor.record ? `${editor.record.id}:${editor.record.revision}` : 'new'}
					kind={kind}
					record={editor.record}
					clients={clients.data}
					onClose={closeEditor}
					onSaved={saved}
					onReload={reloadEditor}
					onClientUnavailable={clients.refetch}
				/>
			) : null}
			{available ? (
				<>
					<label className="catalog-checkbox">
						<input
							type="checkbox"
							checked={showArchived}
							ref={archivedControl}
							onChange={(event) => setShowArchived(event.target.checked)}
						/>
						Show archived {label.toLowerCase()}
					</label>
					{visible?.length ? (
						<ul className="catalog-list">
							{visible.map((record) => (
								<li key={record.id}>
									<article className="panel catalog-record" aria-label={record.name}>
										<div className="catalog-record-info">
											<div className="catalog-record-title">
												<h2>{record.name}</h2>
												{record.archivedAt ? <span className="catalog-archive-label">Archived</span> : null}
											</div>
											<RecordDetails
												record={record}
												client={'clientId' in record && record.clientId ? clientById.get(record.clientId) : undefined}
											/>
											{record.notes ? <p className="catalog-notes">{record.notes}</p> : null}
										</div>
										<div className="form-actions">
											<button type="button" disabled={!!editor || !!pendingId} onClick={(event) => openEditor(record, event.currentTarget)}>
												Edit
											</button>
											<button type="button" disabled={!!editor || !!pendingId} onClick={() => void toggleArchive(record)}>
												{record.archivedAt ? 'Restore' : 'Archive'}
											</button>
										</div>
									</article>
								</li>
							))}
						</ul>
					) : <p className="catalog-empty">No {showArchived ? '' : 'active '}{label.toLowerCase()}.</p>}
				</>
			) : loadError ? null : <p role="status">Loading {label.toLowerCase()}…</p>}
		</section>
	);
}

export function Clients() {
	return <CatalogPage kind="client" />;
}

export function Projects() {
	return <CatalogPage kind="project" />;
}
