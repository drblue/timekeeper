import { useQuery } from '@tanstack/react-query';
import { entriesPath, parseEntryHistoryResponse } from '@timekeeper/contracts';
import type { EntryResponse } from '@timekeeper/contracts';
import { useId, useState } from 'react';
import { readApi } from './api';
import { useSession } from './auth';
import { entriesKey } from './entry-query';
import { stockholmTimeLabel, StockholmTime } from './entry-display';
import { formatDurationInput } from './entry-time';
import { formatSek } from './money';

const historyActionLabels = {
	created: 'Created',
	completed: 'Completed',
	edited: 'Edited',
	deleted: 'Moved to Trash',
	restored: 'Restored',
} as const;

interface HistoryValue {
	label: string;
	value: string;
	recordId?: string | null;
}

function values(entry: EntryResponse): HistoryValue[] {
	return [
		{ label: 'Description', value: entry.description || 'Untitled time entry' },
		{ label: 'Entry type', value: entry.kind === 'timed' ? 'Timed' : 'Duration only' },
		{ label: 'Work date', value: entry.localDate },
		{ label: 'Start', value: entry.kind === 'timed' ? stockholmTimeLabel(entry.startAt) : '—' },
		{ label: 'End', value: entry.kind === 'timed' ? stockholmTimeLabel(entry.endAt) : '—' },
		{ label: 'Duration', value: formatDurationInput(entry.durationSeconds) },
		{ label: 'Project', value: entry.projectName ?? 'None', recordId: entry.projectId },
		{ label: 'Client', value: entry.clientName ?? 'None', recordId: entry.clientId },
		{ label: 'Billability', value: entry.billable ? 'Billable' : 'Non-billable' },
		{ label: 'Hourly rate', value: entry.assignedRateOrePerHour === null ? 'No rate' : `${formatSek(entry.assignedRateOrePerHour)}/hour` },
		{ label: 'Billable amount', value: entry.billableAmountOre === null ? 'Incomplete' : formatSek(entry.billableAmountOre) },
		{ label: 'Status', value: entry.completion === 'complete' ? 'Complete' : 'Incomplete' },
		{ label: 'Location', value: entry.deletedAt ? 'Trash' : 'Time entries' },
	];
}

export function EntryHistory({ entryId }: { entryId: string }) {
	const { refresh } = useSession();
	const id = useId();
	const [open, setOpen] = useState(false);
	const history = useQuery({
		queryKey: [...entriesKey, entryId, 'history'],
		queryFn: ({ signal }) => readApi(`${entriesPath}/${encodeURIComponent(entryId)}/history`,
			parseEntryHistoryResponse, AbortSignal.any([signal, AbortSignal.timeout(10_000)]), refresh),
		enabled: open,
		retry: false,
		networkMode: 'always',
	});
	return (
		<section className="panel entry-history" aria-labelledby={id}>
			<div className="catalog-toolbar">
				<h2 id={id} className="entry-completion-heading">History</h2>
				<button type="button" aria-expanded={open} aria-controls={id + '-changes'}
					onClick={() => setOpen(!open)}>{open ? 'Hide history' : 'Show history'}</button>
			</div>
			<div id={id + '-changes'} hidden={!open}>
				{open && history.isPending ? <p role="status" className="field-hint">Loading history…</p> : null}
				{history.isError ? (
					<div className="feedback error catalog-load-error">
						<p role="alert">Could not load the entry history.</p>
						<button type="button" disabled={history.isFetching} onClick={() => void history.refetch()}>Try again</button>
					</div>
				) : history.data?.length ? (
					<ol className="entry-history-list">
						{history.data.map((change) => {
							const before = change.before ? values(change.before) : null;
							const after = values(change.after);
							const fields = after.flatMap((field, index) => {
								const previous = before?.[index];
								if (previous?.value !== field.value) return [{ ...field, previous: previous?.value }];
								if (previous.recordId === field.recordId) return [];
								return [{
									...field,
									value: field.recordId ? `${field.value} (${field.recordId})` : field.value,
									previous: previous.recordId ? `${previous.value} (${previous.recordId})` : previous.value,
								}];
							});
							return (
								<li key={change.id}>
									<h3>{historyActionLabels[change.action]}</h3>
									<p className="field-hint"><StockholmTime instant={change.at} /></p>
									<dl className="entry-history-values">
										{fields.map(({ label, value, previous }) => (
											<div key={label}>
												<dt>{label}</dt>
												{previous === undefined ? <dd>{value}</dd> : (
													<dd><span>Before: {previous}</span><span>After: {value}</span></dd>
												)}
											</div>
										))}
									</dl>
								</li>
							);
						})}
					</ol>
				) : history.data ? <p className="field-hint">No history recorded for this entry.</p> : null}
			</div>
		</section>
	);
}
