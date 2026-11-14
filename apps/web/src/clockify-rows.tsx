import type { ClockifyPreviewRow, ClockifyRowIssue, ClockifyTimestamp } from '@timekeeper/contracts';
import { useRef, useState } from 'react';
import { formatDurationInput } from './entry-time';

const rowsPerPage = 20;
const statusLabels = { valid: 'Valid', review: 'Needs review', invalid: 'Invalid' } as const;
const issueLabels: Record<ClockifyRowIssue, string> = {
	'column-count': 'This row has the wrong number of columns.',
	'missing-user': 'This row does not identify a Clockify user.',
	'missing-description': 'This row has no description.',
	'invalid-duration': 'Duration (h) must contain a positive duration in hours, minutes and seconds.',
	'invalid-start': 'The start date or time is invalid.',
	'invalid-end': 'The end date or time is invalid.',
	'ambiguous-start': 'The start time occurs twice because the clocks change.',
	'ambiguous-end': 'The end time occurs twice because the clocks change.',
	'nonexistent-start': 'The start time does not occur on this date because the clocks change.',
	'nonexistent-end': 'The end time does not occur on this date because the clocks change.',
	'nonpositive-interval': 'The end time is at or before the start time.',
	'duration-mismatch': 'Duration (h) differs from the elapsed time between start and end.',
};

function sourceTime(date: string, time: string, timestamp: ClockifyTimestamp | null) {
	const source = [date, time].filter(Boolean).join(' ') || '—';
	if (timestamp?.status === 'valid') {
		const offset = timestamp.candidates[0]?.offset;
		return offset ? source + ' (UTC' + offset + ')' : source;
	}
	if (timestamp?.status === 'ambiguous') {
		return source + ' (' + timestamp.candidates.map((candidate) =>
			(candidate.occurrence === 'earlier' ? 'Earlier ' : 'Later ') + 'UTC' + candidate.offset).join(' or ') + ')';
	}
	return source;
}

function Row({ row }: { row: ClockifyPreviewRow }) {
	const { source } = row;
	return (
		<li className="clockify-row">
			<details open={row.issues.length > 0}>
				<summary>
					<span className="clockify-row-title">
						<strong>{source?.description.trim() || 'Untitled row'}</strong>
						<span className="field-hint">Line {row.line}{source?.project ? ' · ' + source.project : ''}</span>
					</span>
					<span className="clockify-row-status">
						<span data-status={row.status}>{statusLabels[row.status]}</span>
						{row.durationSeconds === null ? null : <span>{formatDurationInput(row.durationSeconds)}</span>}
						{row.invoicedTag ? <span>Invoiced tag</span> : null}
					</span>
				</summary>
				{row.issues.length ? (
					<ul className="clockify-issues">
						{row.issues.map((issue) => <li key={issue}>{issueLabels[issue]}</li>)}
					</ul>
				) : null}
				{source ? (
					<dl className="entry-invoice-values clockify-row-values">
						<div><dt>Start</dt><dd>{sourceTime(source.startDate, source.startTime, row.start)}</dd></div>
						<div><dt>End</dt><dd>{sourceTime(source.endDate, source.endTime, row.end)}</dd></div>
						<div><dt>Duration (h)</dt><dd>{source.durationH || '—'}</dd></div>
						{row.timestampDurationSeconds === null ? null : (
							<div><dt>Elapsed by timestamps</dt><dd>{row.timestampDurationSeconds < 0 ? '−' : ''}{formatDurationInput(Math.abs(row.timestampDurationSeconds))}</dd></div>
						)}
						{source.client ? <div><dt>Client</dt><dd>{source.client}</dd></div> : null}
						<div><dt>Invoiced tag</dt><dd>{row.invoicedTag ? 'Present' : 'Absent'}</dd></div>
						{source.tags ? <div><dt>Tags</dt><dd>{source.tags}</dd></div> : null}
					</dl>
				) : null}
				{source ? (
					<details className="clockify-source-fields">
						<summary>Source metadata</summary>
						<dl className="entry-invoice-values clockify-row-values">
							<div className="entry-invoice-reference"><dt>Description</dt><dd className="clockify-source-description">{source.description || '—'}</dd></div>
							<div><dt>Project</dt><dd>{source.project || '—'}</dd></div>
							<div><dt>User</dt><dd>{source.user || '—'}</dd></div>
							<div><dt>Email</dt><dd>{source.email || '—'}</dd></div>
							<div><dt>Task</dt><dd>{source.task || '—'}</dd></div>
							<div><dt>Group</dt><dd>{source.group || '—'}</dd></div>
							<div><dt>Date of creation</dt><dd>{source.dateOfCreation || '—'}</dd></div>
							<div><dt>Duration (decimal)</dt><dd>{source.durationDecimal || '—'}</dd></div>
						</dl>
					</details>
				) : null}
			</details>
		</li>
	);
}

export function ClockifyRows({ rows }: { rows: ClockifyPreviewRow[] }) {
	const [page, setPage] = useState(1);
	const heading = useRef<HTMLHeadingElement>(null);
	const sorted = [...rows].sort((left, right) => Number(right.issues.length > 0) - Number(left.issues.length > 0) || left.line - right.line);
	const pages = Math.ceil(sorted.length / rowsPerPage);
	const visiblePage = Math.min(page, pages);
	const start = (visiblePage - 1) * rowsPerPage;

	function changePage(next: number) {
		setPage(next);
		heading.current?.focus();
	}

	return (
		<div className="clockify-row-review">
			<h3 tabIndex={-1} ref={heading}>Source rows</h3>
			<ul className="clockify-rows">{sorted.slice(start, start + rowsPerPage).map((row) => <Row key={row.line} row={row} />)}</ul>
			{pages > 1 ? (
				<nav className="work-list-pagination" aria-label="Source row pages">
					<button type="button" disabled={visiblePage <= 1} onClick={() => changePage(visiblePage - 1)}>Previous page</button>
					<p className="field-hint" role="status">Page {visiblePage} of {pages}</p>
					<button type="button" disabled={visiblePage >= pages} onClick={() => changePage(visiblePage + 1)}>Next page</button>
				</nav>
			) : null}
		</div>
	);
}
