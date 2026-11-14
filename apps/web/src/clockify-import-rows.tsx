import type { ClockifyImportReviewBody, ClockifyPreviewRow, ClockifyTimestamp } from '@timekeeper/contracts';
import { useId, useRef, useState } from 'react';
import { ClockifyMapping } from './clockify-mapping';
import type { Mapping } from './clockify-mapping';
import type { ClockifyCatalog } from './clockify-catalog';
import { formatDurationInput } from './entry-time';
import { formatSek, parseHourlyRate } from './money';

type RowDecision = ClockifyImportReviewBody['rows'][number];
type Billing = NonNullable<NonNullable<ClockifyImportReviewBody['defaults']>['billing']>;
export type BillingDraft = { mode: '' | 'billable' | 'non-billable'; rate: string };
export type RowDraft = Omit<RowDecision, 'line' | 'association' | 'billing'> & { mapping?: Mapping; billing?: BillingDraft };
export const emptyBilling: BillingDraft = { mode: '', rate: '' };

export function billingChoice(draft: BillingDraft): Billing | undefined {
	if (draft.mode === 'non-billable') return { mode: 'non-billable' };
	if (draft.mode === 'billable') return { mode: 'billable', rateOrePerHour: parseHourlyRate(draft.rate) };
	return undefined;
}

export function ClockifyBilling({ billing, onChange, label, inherited = false }: {
	billing: BillingDraft;
	onChange: (next: BillingDraft) => void;
	label: string;
	inherited?: boolean;
}) {
	const id = useId();
	return (
		<div className="clockify-mapping-fields" role="group" aria-label={label}>
			<div className="field">
				<label htmlFor={id + '-billing'}>Billing</label>
				<select id={id + '-billing'} value={billing.mode}
					onChange={(event) => onChange({ ...billing, mode: event.target.value as BillingDraft['mode'] })}>
					<option value="">{inherited ? 'Use import billing' : 'Choose billing'}</option>
					<option value="billable">Billable</option>
					<option value="non-billable">Non-billable</option>
				</select>
			</div>
			{billing.mode === 'billable' ? (
				<div className="field">
					<label htmlFor={id + '-rate'}>Historical hourly rate (SEK)</label>
					<input id={id + '-rate'} inputMode="decimal" value={billing.rate} maxLength={24}
						onChange={(event) => onChange({ ...billing, rate: event.target.value })} />
				</div>
			) : null}
		</div>
	);
}

const issueLabels: Record<string, string> = {
	'invalid-source': 'The source row is invalid. Exclude it to continue.',
	'ambiguous-start': 'Choose which occurrence of the start time to use.',
	'ambiguous-end': 'Choose which occurrence of the end time to use.',
	'duration-mismatch': 'Choose how to resolve the time and duration mismatch.',
	'invalid-interval': 'The selected times do not make a positive interval.',
	'duplicate-source': 'Identical rows occur in this file. Exclude extra copies to continue.',
	'possible-correction': 'This row may be a correction to work already imported. Exclude it for now.',
	'missing-association': 'Choose a client and project mapping, or choose no client or project.',
	'invalid-association': 'Review this client and project mapping.',
	'missing-billing': 'Choose historical billing for this row.',
	'invalid-rate': 'Enter a valid historical hourly rate.',
	'invoiced-non-billable': 'The Invoiced tag requires billable work.',
	'description-too-long': 'The source description is too long to import.',
	'incomplete-not-approved': 'Approve importing this row as incomplete or complete its billing.',
	'duration-only-incomplete': 'An incomplete row needs start and end times.',
	'amount-out-of-range': 'The calculated amount is outside the supported range.',
};

export function ClockifyImportIssues({ issues }: { issues: string[] }) {
	return <ul className="clockify-issues">{issues.map((issue) => <li key={issue}>{issueLabels[issue] ?? issue.replaceAll('-', ' ')}</li>)}</ul>;
}

function OccurrenceField({ title, timestamp, value, onChange }: {
	title: string;
	timestamp: ClockifyTimestamp;
	value: RowDraft['startOccurrence'];
	onChange: (value: RowDraft['startOccurrence']) => void;
}) {
	const id = useId();
	return (
		<div className="field">
			<label htmlFor={id}>{title} occurrence</label>
			<select id={id} value={value ?? ''} onChange={(event) => onChange((event.target.value || undefined) as RowDraft['startOccurrence'])}>
				<option value="">Choose occurrence</option>
				{timestamp.candidates.map((candidate) => (
					<option key={candidate.instant} value={candidate.occurrence ?? ''}>
						{candidate.occurrence === 'earlier' ? 'Earlier' : 'Later'} · UTC{candidate.offset}
					</option>
				))}
			</select>
		</div>
	);
}

function MappingRow({ row, draft, onChange, catalog, mapping, issues }: {
	row: ClockifyPreviewRow;
	draft: RowDraft;
	onChange: (draft: RowDraft) => void;
	catalog: ClockifyCatalog;
	mapping: Mapping;
	issues: string[];
}) {
	const id = useId();
	return (
		<li className="clockify-row">
			<details>
				<summary>
					<span className="clockify-row-title">
						<strong>{row.source?.description.trim() || 'Untitled row'}</strong>
						<span className="field-hint">Line {row.line}{row.durationSeconds === null ? '' : ' · ' + formatDurationInput(row.durationSeconds)}</span>
					</span>
					<span className="clockify-row-status">
						{draft.exclude ? 'Excluded' : issues.length ? 'Blocked' : row.status === 'valid' ? 'Review row' : 'Needs review'}
						{row.invoicedTag ? <span>Invoiced tag</span> : null}
					</span>
				</summary>
				<div className="clockify-row-edit record-editor">
					{issues.length ? <ClockifyImportIssues issues={issues} /> : null}
					<label className="catalog-checkbox"><input type="checkbox" checked={draft.exclude ?? false}
						onChange={(event) => onChange({ ...draft, exclude: event.target.checked })} /> Exclude row {row.line}</label>
					{row.source && !draft.exclude ? (
						<>
							{row.start?.status === 'ambiguous' ? <OccurrenceField title="Start" timestamp={row.start} value={draft.startOccurrence}
								onChange={(startOccurrence) => onChange({ ...draft, startOccurrence })} /> : null}
							{row.end?.status === 'ambiguous' ? <OccurrenceField title="End" timestamp={row.end} value={draft.endOccurrence}
								onChange={(endOccurrence) => onChange({ ...draft, endOccurrence })} /> : null}
							{row.issues.some((issue) => ['duration-mismatch', 'ambiguous-start', 'ambiguous-end'].includes(issue)) ? (
								<div className="field">
									<label htmlFor={id + '-duration'}>Timing</label>
									<select id={id + '-duration'} value={draft.durationChoice ?? ''} onChange={(event) =>
										onChange({ ...draft, durationChoice: (event.target.value || undefined) as RowDraft['durationChoice'] })}>
										<option value="">Use matching source times and duration</option>
										<option value="use-timestamps">Use elapsed time between timestamps</option>
										<option value="duration-only">Use Duration (h) as a duration-only entry</option>
									</select>
								</div>
							) : null}
							<label className="catalog-checkbox"><input type="checkbox" checked={draft.acceptIncomplete ?? false}
								onChange={(event) => onChange({ ...draft, acceptIncomplete: event.target.checked })} />
								Accept missing description or rate as incomplete</label>
							<ClockifyBilling billing={draft.billing ?? emptyBilling} label={'Billing for line ' + row.line} inherited
								onChange={(billing) => onChange({ ...draft, billing })} />
							<label className="catalog-checkbox"><input type="checkbox" checked={!!draft.mapping}
								onChange={(event) => onChange({ ...draft, mapping: event.target.checked ? mapping : undefined })} />
								Override client and project for this row</label>
							{draft.mapping ? <ClockifyMapping mapping={draft.mapping} catalog={catalog} label={'Mapping for line ' + row.line}
								onChange={(next) => onChange({ ...draft, mapping: next })} /> : null}
						</>
					) : null}
				</div>
			</details>
		</li>
	);
}

export function ClockifyImportRows({ rows, drafts, update, catalog, mappingFor, issues }: {
	rows: ClockifyPreviewRow[];
	drafts: Record<number, RowDraft>;
	update: (line: number, next: RowDraft) => void;
	catalog: ClockifyCatalog;
	mappingFor: (row: ClockifyPreviewRow) => Mapping;
	issues: Map<number, string[]>;
}) {
	const [page, setPage] = useState(1);
	const heading = useRef<HTMLHeadingElement>(null);
	const rowsPerPage = 20;
	const sorted = [...rows].sort((a, b) =>
		Number(issues.has(b.line)) - Number(issues.has(a.line)) ||
		Number(b.status !== 'valid') - Number(a.status !== 'valid') || a.line - b.line);
	const pages = Math.max(1, Math.ceil(rows.length / rowsPerPage));
	const currentPage = Math.min(page, pages);
	const start = (currentPage - 1) * rowsPerPage;

	function changePage(next: number) {
		setPage(next);
		heading.current?.focus();
	}

	return (
		<section className="panel report-section clockify-row-review" aria-label="Row choices">
			<h2 ref={heading} tabIndex={-1}>Row choices</h2>
			<p className="field-hint">Open a row to change its billing, client, project, or timing, or to exclude it.</p>
			<ul className="clockify-rows">
				{sorted.slice(start, start + rowsPerPage).map((row) => (
					<MappingRow key={row.line} row={row} draft={drafts[row.line] ?? {}} onChange={(next) => update(row.line, next)}
						catalog={catalog} mapping={mappingFor(row)} issues={issues.get(row.line) ?? []} />
				))}
			</ul>
			{pages > 1 ? (
				<nav className="work-list-pagination" aria-label="Import row pages">
					<button type="button" disabled={currentPage <= 1} onClick={() => changePage(currentPage - 1)}>Previous page</button>
					<p role="status" className="field-hint">Page {currentPage} of {pages}</p>
					<button type="button" disabled={currentPage >= pages} onClick={() => changePage(currentPage + 1)}>Next page</button>
				</nav>
			) : null}
		</section>
	);
}

export function billingLabel(billing?: Billing) {
	if (!billing) return 'Billing not selected';
	if (billing.mode === 'non-billable') return 'Non-billable';
	return billing.rateOrePerHour === null ? 'Billable · Missing rate' : 'Billable · ' + formatSek(billing.rateOrePerHour) + '/h';
}
