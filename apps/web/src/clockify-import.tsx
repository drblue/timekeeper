import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
	clockifyCommitPath, clockifyReviewPath, clockifyStagePath, csrfHeader, idempotencyKeyHeader,
	parseClientListResponse, parseClockifyImportCommitResponse, parseClockifyImportReviewResponse,
	parseClockifyStageResponse, parseProjectListResponse,
} from '@timekeeper/contracts';
import type {
	ClockifyImportCommitResponse, ClockifyImportReviewBody, ClockifyImportReviewResponse, ClockifyPreviewResponse,
	ClockifyImportRowDecision, ClockifyPreviewRow, ClockifyStageResponse,
} from '@timekeeper/contracts';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ApiRequestError, readApi, requestError, writeApi } from './api';
import { authError, useSession } from './auth';
import { catalogKey, catalogPaths } from './catalog';
import { ClockifyCorrectionFields, correctionDecision, isIncompleteCorrection } from './clockify-corrections';
import type { CorrectionDraft } from './clockify-corrections';
import { ClockifyDuplicateGroups } from './clockify-duplicate-groups';
import { clockifyCatalogLabels } from './clockify-catalog';
import type { ClockifyCatalog } from './clockify-catalog';
import { readPendingClockifyImport, writePendingClockifyImport } from './clockify-import-pending';
import type { PendingImport } from './clockify-import-pending';
import { billingChoice, billingLabel, ClockifyBilling, ClockifyImportIssues, ClockifyImportRows, emptyBilling } from './clockify-import-rows';
import type { BillingDraft, RowDraft } from './clockify-import-rows';
import { ClockifyMapping, emptyMapping, mappingChoice, suggestedMapping } from './clockify-mapping';
import type { Mapping } from './clockify-mapping';
import { entriesKey } from './entry-query';
import { formatDuration, StockholmTime } from './entry-display';
import { formatSek } from './money';
import { operationKey } from './timer-operation';

interface SourceGroup {
	key: string;
	client: string;
	project: string;
	count: number;
}

function sourceGroup(row: ClockifyPreviewRow) {
	const client = row.source?.client.trim() ?? '';
	const project = row.source?.project.trim() ?? '';
	return { key: JSON.stringify([client, project]), client, project };
}

function sourceGroups(rows: ClockifyPreviewRow[]) {
	const groups = new Map<string, SourceGroup>();
	for (const row of rows) {
		if (!row.source) continue;
		const source = sourceGroup(row);
		const group = groups.get(source.key);
		if (group) group.count += 1;
		else groups.set(source.key, { ...source, count: 1 });
	}
	return [...groups.values()];
}

function importError(cause: unknown) {
	if (cause instanceof ApiRequestError) {
		switch (cause.code) {
			case 'CLOCKIFY_STAGE_EXPIRED':
			case 'CLOCKIFY_STAGE_NOT_FOUND':
				return 'The staged file expired. Prepare the file again to continue.';
			case 'CLOCKIFY_PREVIEW_CHANGED':
				return 'The saved work or catalog changed. Review the import again before confirming.';
			case 'CLOCKIFY_PREVIEW_NOT_FOUND':
			case 'CLOCKIFY_PREVIEW_EXPIRED':
				return 'This review expired. Review the import again before confirming.';
			case 'CLOCKIFY_STAGE_LIMIT':
				return 'Too many files are staged. Wait for an earlier staged file to expire and try again.';
			case 'CLOCKIFY_PREVIEW_LIMIT':
				return 'There are too many active import reviews. Wait for an earlier review to expire and try again.';
			case 'CLOCKIFY_INVALID_MULTIPLICITY':
				return 'The identical rows changed. Check how many copies to keep and update the review.';
			case 'CLOCKIFY_IMPORT_TOO_LARGE':
				return 'This import is too large. Export a shorter date range.';
			case 'IDEMPOTENCY_CONFLICT':
				return 'The import request does not match its original confirmation. Review the import again.';
		}
		if (cause.response.status === 413) return 'The import is too large. Export a shorter date range.';
		if (cause.response.status === 422) return 'Check the import choices and try again.';
	}
	return 'Could not reach the import service. Check your connection and try again.';
}

function ReviewCounts({ counts }: { counts: ClockifyImportReviewResponse['counts'] }) {
	return (
		<dl className="clockify-counts">
			<div><dt>New entries</dt><dd>{counts.new}</dd></div>
			<div><dt>Already imported</dt><dd>{counts.alreadyImported}</dd></div>
			<div><dt>Excluded</dt><dd>{counts.excluded}</dd></div>
			{counts.keptExisting ? <div><dt>Kept existing</dt><dd>{counts.keptExisting}</dd></div> : null}
			{counts.updatedExisting ? <div><dt>Updated existing</dt><dd>{counts.updatedExisting}</dd></div> : null}
			{counts.duplicateOmitted ? <div><dt>Identical copies omitted</dt><dd>{counts.duplicateOmitted}</dd></div> : null}
			<div><dt>Blocked</dt><dd>{counts.blocked}</dd></div>
			<div><dt>Incomplete</dt><dd>{counts.incomplete}</dd></div>
			<div><dt>Invoiced</dt><dd>{counts.invoiced}</dd></div>
		</dl>
	);
}

const commitRejections = new Set(['CLOCKIFY_PREVIEW_CHANGED', 'CLOCKIFY_PREVIEW_EXPIRED', 'CLOCKIFY_PREVIEW_NOT_FOUND', 'IDEMPOTENCY_CONFLICT']);

const disposition = { new: 'New entry', 'already-imported': 'Already imported', excluded: 'Excluded', 'duplicate-omitted': 'Identical copy omitted', 'kept-existing': 'Keep existing entry', 'updated-existing': 'Update existing entry', blocked: 'Blocked' } as const;

function ImportReview({ review, rows, catalog, pending, error, duplicateCounts, onDuplicateCount, correctionDrafts, correctionsDirty, onCorrection, onUpdateReview, onConfirm, onEdit }: {
	review: ClockifyImportReviewResponse;
	rows: ClockifyPreviewRow[];
	catalog: ClockifyCatalog;
	pending: boolean;
	error: string;
	duplicateCounts: Record<string, number>;
	onDuplicateCount: (fingerprint: string, count: number) => void;
	correctionDrafts: Record<number, RowDraft>;
	correctionsDirty: boolean;
	onCorrection: (line: number, draft: CorrectionDraft) => void;
	onUpdateReview: () => void;
	onConfirm: () => void;
	onEdit: () => void;
}) {
	const heading = useRef<HTMLHeadingElement>(null);
	const reviewError = useRef<HTMLParagraphElement>(null);
	const sources = new Map(rows.map((row) => [row.line, row]));
	const dirty = correctionsDirty || review.duplicateGroups.some((group) =>
		(duplicateCounts[group.fingerprint] ?? group.selectedCount) !== group.selectedCount);
	const invalid = review.duplicateGroups.some((group) => {
		const count = duplicateCounts[group.fingerprint] ?? group.selectedCount;
		return !Number.isInteger(count) || count < 1 || count > group.lines.length;
	});
	const sorted = [...review.rows].sort((a, b) => Number(b.status === 'blocked') - Number(a.status === 'blocked') || a.line - b.line);
	const [limit, setLimit] = useState(20);
	const [correctionLimit, setCorrectionLimit] = useState(5);
	const corrections = sorted.filter((row) => row.correction || !!correctionDrafts[row.line]?.correction?.mode);
	const invalidCorrection = corrections.some((row) => isIncompleteCorrection(correctionDrafts[row.line]?.correction));
	const approved = review.rows.flatMap((row) => row.approved ? [row.approved] : []);
	const labelClient = clockifyCatalogLabels([
		...catalog.clients,
		...approved.flatMap(({ clientId, clientName }) => clientId && clientName ? [{ id: clientId, name: clientName }] : []),
		...review.createProjects.flatMap(({ clientId, clientName }) => clientId && clientName ? [{ id: clientId, name: clientName }] : []),
	]);
	const labelProject = clockifyCatalogLabels([
		...catalog.projects,
		...approved.flatMap(({ projectId, projectName }) => projectId && projectName ? [{ id: projectId, name: projectName }] : []),
	]);
	const clientLabel = (name: string | null, id: string | null) =>
		name === null ? 'No client' : id ? labelClient(name, id) + ' (existing)' : name + ' (new)';
	const projectLabel = (name: string | null, id: string | null) =>
		name === null ? 'No project' : id ? labelProject(name, id) + ' (existing)' : name + ' (new)';
	useLayoutEffect(() => heading.current?.focus(), [review]);
	useLayoutEffect(() => { if (error && !pending) reviewError.current?.focus(); }, [error, pending]);
	return (
		<section className="panel report-section clockify-results" aria-labelledby="clockify-review-heading">
			<h2 id="clockify-review-heading" tabIndex={-1} ref={heading}>Review import</h2>
			<ReviewCounts counts={review.counts} />
			{error ? <p className="feedback error" role="alert" ref={reviewError} tabIndex={-1}>{error}</p> : null}
			{review.duplicateGroups.length ? (
				<ClockifyDuplicateGroups groups={review.duplicateGroups} rows={sources} counts={duplicateCounts} disabled={pending}
					onChange={(group, count) => onDuplicateCount(group.fingerprint, count)} />
			) : null}
			{corrections.length ? (
				<div className="clockify-correction-list">
					<h3>Possible corrections</h3>
					<ul className="clockify-rows">
						{corrections.slice(0, correctionLimit).map((item, index) => {
							const row = sources.get(item.line);
							return row ? (
								<li key={item.line} className="clockify-row">
									<details open={index === 0}>
										<summary>Line {item.line} · {row.source?.description.trim() || 'Untitled row'} · {disposition[item.status]}</summary>
										{item.issues.length ? <ClockifyImportIssues issues={item.issues} /> : null}
										<ClockifyCorrectionFields row={row} review={item.correction} draft={correctionDrafts[item.line]?.correction}
											onChange={(draft) => onCorrection(item.line, draft)} disabled={pending} />
									</details>
								</li>
							) : null;
						})}
					</ul>
					{correctionLimit < corrections.length ? <button type="button" onClick={() => setCorrectionLimit(correctionLimit + 5)}>Show more corrections</button> : null}
				</div>
			) : null}
			{dirty ? <p className="feedback warning" role="status">{invalid
				? 'Enter a whole number from 1 to the number of identical rows.'
				: 'Update the review to see the effects of these choices.'}</p> : null}
			{review.createClients.length || review.createProjects.length ? (
				<div className="clockify-review-catalog">
					<h3>Catalog records to create</h3>
					<ul>
						{review.createClients.map(({ name }) => <li key={'client:' + name}>Client · {name}</li>)}
						{review.createProjects.map(({ name, clientName, clientId }) => <li key={JSON.stringify([name, clientName, clientId])}>
							Project · {name}{clientName ? ' · ' + clientLabel(clientName, clientId) : ''}
						</li>)}
					</ul>
					<p className="field-hint">Existing catalog defaults stay as they are.</p>
				</div>
			) : null}
			{review.counts.blocked ? <p className="feedback warning" role="status">Resolve or explicitly exclude blocked rows before importing.</p> : null}
			{review.canCommit && !review.counts.new && !review.counts.keptExisting && !review.counts.updatedExisting ? <p className="field-hint">This selection has no new entries to import.</p> : null}
			<details open={review.counts.blocked > 0}>
				<summary>Review source rows</summary>
				<ul className="clockify-rows">
					{sorted.slice(0, limit).map((row) => (
						<li key={row.line} className="clockify-row">
							<strong>Line {row.line} · {sources.get(row.line)?.source?.description.trim() || 'Untitled row'}</strong>
							<p className="field-hint">{disposition[row.status]}{row.incomplete ? ' · Incomplete' : ''}{row.invoiced ? ' · Invoiced' : ''}</p>
							{row.approved ? (
								<dl className="entry-invoice-values clockify-row-values">
									<div><dt>Client and project</dt><dd>{clientLabel(row.approved.clientName, row.approved.clientId)} · {projectLabel(row.approved.projectName, row.approved.projectId)}</dd></div>
									<div><dt>Billing</dt><dd>{billingLabel(row.approved.billable
										? { mode: 'billable', rateOrePerHour: row.approved.rateOrePerHour } : { mode: 'non-billable' })}</dd></div>
									<div><dt>Duration</dt><dd>{formatDuration(row.approved.durationSeconds)}</dd></div>
									<div><dt>Amount</dt><dd>{row.approved.amountOre === null ? 'Incomplete' : formatSek(row.approved.amountOre)}</dd></div>
									<div className="entry-invoice-reference"><dt>Work time (Stockholm)</dt><dd>{row.approved.startAt && row.approved.endAt ? (
										<><StockholmTime instant={row.approved.startAt} /> to <StockholmTime instant={row.approved.endAt} /></>
									) : <time dateTime={row.approved.localDate}>{row.approved.localDate}</time>}</dd></div>
								</dl>
							) : null}
							{row.issues.length ? <ClockifyImportIssues issues={row.issues} /> : null}
						</li>
					))}
				</ul>
				{limit < sorted.length ? <button type="button" onClick={() => setLimit(limit + 20)}>Show more rows</button> : null}
			</details>
			<div className="form-actions">
				{dirty ? <button type="button" className="primary" disabled={pending || invalid || invalidCorrection} onClick={onUpdateReview}>
					{pending ? 'Updating review…' : 'Update review'}
				</button> : null}
				{!dirty && review.canCommit && review.previewToken ? (
					<button type="button" className="primary" disabled={pending} onClick={onConfirm}>
						{review.counts.new || review.counts.keptExisting || review.counts.updatedExisting ? 'Confirm import' : 'Confirm no changes'}
					</button>
				) : null}
				<button type="button" disabled={pending} onClick={onEdit}>Edit import choices</button>
			</div>
		</section>
	);
}

function ImportResult({ result, onBack }: { result: ClockifyImportCommitResponse; onBack: () => void }) {
	const heading = useRef<HTMLHeadingElement>(null);
	useLayoutEffect(() => heading.current?.focus(), []);
	return (
		<section className="panel report-section" aria-labelledby="clockify-complete-heading">
			<h2 id="clockify-complete-heading" ref={heading} tabIndex={-1}>{result.createdCount || result.keptExistingCount || result.updatedExistingCount ? 'Import complete' : 'No new entries imported'}</h2>
			<ReviewCounts counts={{ new: result.createdCount, alreadyImported: result.alreadyImportedCount, excluded: result.excludedCount,
				blocked: 0, incomplete: result.incompleteCount, invoiced: result.invoicedCount, duplicateOmitted: result.duplicateOmittedCount ?? 0,
				keptExisting: result.keptExistingCount ?? 0, updatedExisting: result.updatedExistingCount ?? 0 }} />
			<div className="form-actions"><button type="button" onClick={onBack}>Inspect another file</button></div>
		</section>
	);
}

export function ClockifyImport({ file, inspection, onBack, onFinished, pending, onPending }: {
	file?: File;
	inspection?: ClockifyPreviewResponse;
	onBack: () => void;
	onFinished: () => void;
	pending: PendingImport | null;
	onPending: (next: PendingImport | null) => void;
}) {
	const { session, refresh } = useSession();
	const queryClient = useQueryClient();
	const [stage, setStage] = useState<ClockifyStageResponse>();
	const groups = sourceGroups(stage?.inspection.rows ?? []);
	const [groupMapping, setGroupMapping] = useState<Record<string, Mapping>>({});
	const [useBulkMapping, setUseBulkMapping] = useState(false);
	const [bulkMapping, setBulkMapping] = useState(emptyMapping);
	const [billing, setBilling] = useState(emptyBilling);
	const [rows, setRows] = useState<Record<number, RowDraft>>({});
	const [review, setReview] = useState<ClockifyImportReviewResponse>();
	const [correctionsDirty, setCorrectionsDirty] = useState(false);
	const [duplicateCounts, setDuplicateCounts] = useState<Record<string, number>>({});
	const [previousIssues, setPreviousIssues] = useState(new Map<number, string[]>());
	const [result, setResult] = useState<ClockifyImportCommitResponse>();
	const editingReturn = useRef(false);
	const [busy, setBusy] = useState<'stage' | 'review' | 'commit'>();
	const [stageExpired, setStageExpired] = useState(false);
	const [error, setError] = useState('');
	const [groupPage, setGroupPage] = useState(0);
	const heading = useRef<HTMLHeadingElement>(null);
	const alert = useRef<HTMLParagraphElement>(null);
	const active = useRef<AbortController | null>(null);
	const clients = useQuery({
		queryKey: [...catalogKey, 'client', 'active'],
		queryFn: ({ signal }) => readApi(catalogPaths.client, parseClientListResponse, signal, refresh),
		enabled: !!file, retry: false,
	});
	const projects = useQuery({
		queryKey: [...catalogKey, 'project', 'active'],
		queryFn: ({ signal }) => readApi(catalogPaths.project, parseProjectListResponse, signal, refresh),
		enabled: !!file, retry: false,
	});
	const catalog = { clients: clients.data ?? [], projects: projects.data ?? [] };
	const catalogReady = !!clients.data && !!projects.data && !clients.isError && !projects.isError;
	const stageRows = stage?.inspection.rows ?? [];

	useLayoutEffect(() => heading.current?.focus(), []);
	useLayoutEffect(() => {
		if (editingReturn.current && !review && !busy) {
			editingReturn.current = false;
			heading.current?.focus();
		}
	}, [review, busy]);
	useLayoutEffect(() => {
		if (error && !busy) alert.current?.focus();
		else if (pending && !busy) heading.current?.focus();
	}, [error, busy, pending]);

	useEffect(() => {
		if (file && inspection && !pending) void stageFile();
		return () => {
			active.current?.abort();
			active.current = null;
		};
	}, [file, inspection]);

	function mappingFor(row: ClockifyPreviewRow) {
		if (useBulkMapping) return bulkMapping;
		const source = sourceGroup(row);
		return groupMapping[source.key] ?? suggestedMapping(source.client, source.project, catalog);
	}

	async function message(cause: unknown) {
		return cause instanceof ApiRequestError && [401, 403].includes(cause.response.status)
			? await authError(cause.response, refresh) : importError(cause);
	}

	async function stageFile() {
		if (!file || !inspection?.selectedUserId || active.current) return;
		const controller = new AbortController();
		active.current = controller;
		setBusy('stage');
		setError('');
		try {
			const query = new URLSearchParams({ sourceTimeZone: inspection.sourceTimeZone, selectedUserId: inspection.selectedUserId });
			const response = await fetch(clockifyStagePath + '?' + query, {
				method: 'POST', cache: 'no-store', headers: { [csrfHeader]: session.csrfToken, 'Content-Type': 'text/csv' },
				body: file, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]),
			});
			if (!response.ok) throw await requestError(response);
			const next = parseClockifyStageResponse(await response.json());
			if (controller.signal.aborted) return;
			setStage(next);
			setStageExpired(false);
			editingReturn.current = true;
		} catch (cause) {
			if (!controller.signal.aborted) setError(await message(cause));
		} finally {
			if (active.current === controller) {
				active.current = null;
				setBusy(undefined);
			}
		}
	}

	function buildReview(): ClockifyImportReviewBody {
		if (!stage) throw new Error('Inspect the file again.');
		const hasNewChoices = stage.inspection.rows.some((row) => {
			const draft = rows[row.line];
			return row.source && !draft?.exclude && draft?.correction?.mode !== 'keep' && draft?.correction?.mode !== 'update';
		});
		const defaultBilling = hasNewChoices ? billingChoice(billing) : undefined;
		const multiplicities = Object.entries(duplicateCounts).map(([fingerprint, count]) => ({ fingerprint, count }));
		return {
			stageId: stage.stageId,
			defaults: { billing: defaultBilling },
			multiplicities: multiplicities.length ? multiplicities : undefined,
			rows: stage.inspection.rows.flatMap<ClockifyImportRowDecision>((row) => {
				const draft = rows[row.line] ?? {};
				if (draft.exclude) return [{ line: row.line, exclude: true }];
				const { mapping, billing: rowBilling, correction: correctionDraft, ...decisions } = draft;
				if (isIncompleteCorrection(correctionDraft)) throw new Error('Choose a matching entry for line ' + row.line + '.');
				const correction = correctionDecision(correctionDraft);
				if (correction?.mode === 'keep' || correction?.mode === 'update') return [{ line: row.line, ...decisions, correction }];
				const association = row.source ? mappingChoice(mapping ?? mappingFor(row), catalog) : undefined;
				if (row.source && (mapping || useBulkMapping) && !association) throw new Error('Complete the client and project override for line ' + row.line + '.');
				const billing = rowBilling ? billingChoice(rowBilling) : undefined;
				return [{ line: row.line, ...decisions, association, billing, correction }];
			}),
		};
	}

	async function reviewImport() {
		if (active.current || !catalogReady) return;
		setError('');
		let body: ClockifyImportReviewBody;
		try {
			body = buildReview();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : 'Check the import choices.');
			return;
		}
		const controller = new AbortController();
		active.current = controller;
		setBusy('review');
		try {
			const response = await writeApi(clockifyReviewPath, 'POST', session.csrfToken, body,
				{ signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]) });
			const next = parseClockifyImportReviewResponse(await response.json());
			if (controller.signal.aborted) return;
			setPreviousIssues(new Map(next.rows.filter((row) => row.issues.length).map((row) => [row.line, row.issues])));
			setDuplicateCounts((previous) => Object.fromEntries(next.duplicateGroups.flatMap((group) => {
				const count = previous[group.fingerprint];
				return count === group.selectedCount ? [[group.fingerprint, count]] : [];
			})));
			setCorrectionsDirty(false);
			setReview(next);
		} catch (cause) {
			if (!controller.signal.aborted) {
				if (cause instanceof ApiRequestError && ['CLOCKIFY_STAGE_EXPIRED', 'CLOCKIFY_STAGE_NOT_FOUND'].includes(cause.code ?? '')) {
					setStageExpired(true);
					setReview(undefined);
				}
				setError(await message(cause));
			}
		} finally {
			if (active.current === controller) {
				active.current = null;
				setBusy(undefined);
			}
		}
	}

	async function commit(operation: PendingImport) {
		if (busy) return;
		setBusy('commit');
		setError('');
		onPending(operation);
		try {
			const response = await writeApi(clockifyCommitPath, 'POST', session.csrfToken, { previewToken: operation.previewToken }, {
				headers: { [idempotencyKeyHeader]: operation.key }, signal: AbortSignal.timeout(40_000),
			});
			const saved = parseClockifyImportCommitResponse(await response.json());
			onPending(null);
			setResult(saved);
			void queryClient.invalidateQueries({ queryKey: entriesKey });
			void queryClient.invalidateQueries({ queryKey: catalogKey });
			void queryClient.invalidateQueries({ queryKey: ['clockify-batches'] });
		} catch (cause) {
			if (cause instanceof ApiRequestError && commitRejections.has(cause.code ?? '')) {
				onPending(null);
				setReview(undefined);
				void clients.refetch();
				void projects.refetch();
				setError(importError(cause));
			} else {
				const auth = cause instanceof ApiRequestError && [401, 403].includes(cause.response.status);
				setError(auth ? await message(cause) : 'Could not confirm the import. Retry the same request to check its result.');
			}
		} finally {
			setBusy(undefined);
		}
	}

	function updateRow(line: number, next: RowDraft) {
		const previous = rows[line];
		if (!!previous?.exclude !== !!next.exclude || previous?.startOccurrence !== next.startOccurrence ||
			previous?.endOccurrence !== next.endOccurrence || previous?.durationChoice !== next.durationChoice) {
			setDuplicateCounts({});
		}
		setRows({ ...rows, [line]: next });
	}

	function edit() {
		setDuplicateCounts((current) => {
			const next = { ...current };
			for (const group of review?.duplicateGroups ?? []) {
				if (next[group.fingerprint] !== group.selectedCount) delete next[group.fingerprint];
			}
			return next;
		});
		setReview(undefined);
		setError('');
		editingReturn.current = true;
	}

	if (result) return <ImportResult result={result} onBack={onFinished} />;
	if (review && !pending) return <ImportReview review={review} rows={stageRows} catalog={catalog} pending={!!busy}
		error={error} duplicateCounts={duplicateCounts} correctionDrafts={rows} correctionsDirty={correctionsDirty}
		onCorrection={(line, correction) => {
			setRows((previous) => ({ ...previous, [line]: { ...previous[line], correction } }));
			setCorrectionsDirty(true);
			setError('');
		}} onEdit={edit} onUpdateReview={() => void reviewImport()}
		onDuplicateCount={(fingerprint, count) => {
			setError('');
			setDuplicateCounts({ ...duplicateCounts, [fingerprint]: count });
		}} onConfirm={() => {
		if (review.previewToken) void commit({ previewToken: review.previewToken, key: operationKey() });
	}} />;
	return (
		<div className="clockify-import">
			<section className="panel report-section" aria-labelledby="clockify-import-heading">
				<h2 id="clockify-import-heading" tabIndex={-1} ref={heading}>{pending ? 'Check confirmed import' : 'Prepare Clockify import'}</h2>
				{error ? <p className="feedback error" role="alert" ref={alert} tabIndex={-1}>{error}</p> : null}
				{pending ? (
					<>
						<p role="status">{busy === 'commit' ? 'Applying import…' : 'An import confirmation is waiting for a result.'}</p>
						<div className="form-actions">
							<button type="button" className="primary" disabled={!!busy} onClick={() => void commit(pending)}>Retry confirmation</button>
						</div>
					</>
				) : !stage ? (
					<>
						<p className="field-hint">{busy === 'stage' ? 'Preparing mapping choices…' : 'Prepare the selected rows for mapping.'}</p>
						<div className="form-actions">
							{file && busy !== 'stage' ? <button type="button" className="primary" onClick={() => void stageFile()}>Try preparing again</button> : null}
							<button type="button" onClick={onBack}>Back to inspection</button>
						</div>
					</>
				) : (
					<>
						{clients.isError || projects.isError ? <div className="feedback error catalog-load-error">
							<p role="alert">Could not refresh clients and projects.</p>
							<button type="button" onClick={() => { void clients.refetch(); void projects.refetch(); }}>Reload catalog</button>
						</div> : null}
						<fieldset className="record-fields" disabled={!!busy}>
							<div className="record-editor">
								<h3>Historical billing</h3>
								<p className="field-hint">Use the rate that applied to this work. Override individual rows below when rates differ.</p>
								<ClockifyBilling billing={billing} label="Default historical billing" onChange={setBilling} />
							</div>
							<div className="record-editor">
								<h3>Client and project mappings</h3>
								<p className="field-hint">Review suggested matches and choose any new records to create.</p>
								{!catalogReady && !clients.isError && !projects.isError ? <p className="field-hint" role="status">Loading clients and projects…</p> : null}
								<label className="catalog-checkbox"><input type="checkbox" checked={useBulkMapping}
									onChange={(event) => setUseBulkMapping(event.target.checked)} /> Use one client and project for all rows</label>
								{useBulkMapping ? <ClockifyMapping mapping={bulkMapping} catalog={catalog} onChange={setBulkMapping} label="Default mapping" /> : (
									<>
										{groups.slice(groupPage * 8, (groupPage + 1) * 8).map((group) => {
											const label = [group.client || 'No source client', group.project || 'No source project'].join(' · ');
											return (
												<div className="clockify-mapping-group" key={group.key}>
													<h4>{label} <span className="field-hint">· {group.count} {group.count === 1 ? 'row' : 'rows'}</span></h4>
													<ClockifyMapping mapping={groupMapping[group.key] ?? suggestedMapping(group.client, group.project, catalog)} catalog={catalog} label={label}
														onChange={(mapping) => setGroupMapping({ ...groupMapping, [group.key]: mapping })} />
												</div>
											);
										})}
										{groups.length > 8 ? <nav className="work-list-pagination" aria-label="Source mapping pages">
											<button type="button" disabled={groupPage === 0} onClick={() => setGroupPage(groupPage - 1)}>Previous mappings</button>
											<p className="field-hint" role="status">Page {groupPage + 1} of {Math.ceil(groups.length / 8)}</p>
											<button type="button" disabled={(groupPage + 1) * 8 >= groups.length} onClick={() => setGroupPage(groupPage + 1)}>Next mappings</button>
										</nav> : null}
									</>
								)}
							</div>
							<p className="field-hint">Rows tagged Invoiced keep that status. Rows without the tag remain unmarked.</p>
						</fieldset>
					</>
				)}
			</section>
			{stage && !pending && !review ? (
				<>
					<fieldset className="record-fields" disabled={!!busy}>
						<ClockifyImportRows rows={stageRows} drafts={rows} update={updateRow} catalog={catalog} mappingFor={mappingFor} issues={previousIssues} />
					</fieldset>
					<div className="form-actions">
						{stageExpired ? (
							<button type="button" className="primary" disabled={!!busy || !file} onClick={() => void stageFile()}>
								{busy === 'stage' ? 'Preparing…' : 'Prepare file again'}
							</button>
						) : (
							<button type="button" className="primary" disabled={!!busy || !catalogReady} onClick={() => void reviewImport()}>
								{busy === 'review' ? 'Reviewing…' : 'Review import choices'}
							</button>
						)}
						<button type="button" disabled={!!busy} onClick={onBack}>Back to inspection</button>
					</div>
				</>
			) : null}
		</div>
	);
}

export function usePendingClockifyImport(account: string) {
	const [pending, setPending] = useState(() => readPendingClockifyImport(account));
	function save(next: PendingImport | null) {
		writePendingClockifyImport(account, next);
		setPending(next);
	}
	return [pending, save] as const;
}
