import type { ClockifyImportReviewResponse, ClockifyPreviewRow } from '@timekeeper/contracts';
import { useId, useState } from 'react';
import { formatDurationInput } from './entry-time';

type DuplicateGroup = ClockifyImportReviewResponse['duplicateGroups'][number];

function DuplicateGroupFields({ group, source, count, onChange, disabled }: {
	group: DuplicateGroup;
	source?: ClockifyPreviewRow;
	count: number;
	onChange: (count: number) => void;
	disabled: boolean;
}) {
	const id = useId();
	const firstLine = group.lines[0];
	return (
		<li className="clockify-row clockify-duplicate-group">
			<strong>{source?.source?.description.trim() || 'Untitled row'}</strong>
			<p className="field-hint">
				{group.lines.length} identical rows{source?.durationSeconds != null ? ' · ' + formatDurationInput(source.durationSeconds) : ''}
			</p>
			{group.lines.length <= 8 ? <p className="field-hint">Source lines {group.lines.join(', ')}</p> : (
				<details>
					<summary>Show source lines</summary>
					<p className="field-hint">{group.lines.join(', ')}</p>
				</details>
			)}
			<dl className="clockify-counts">
				<div><dt>Previously accepted</dt><dd>{group.existingCount}</dd></div>
				<div><dt>Accepted in review</dt><dd>{group.selectedCount}</dd></div>
				<div><dt>New copies selected</dt><dd>{group.newCount}</dd></div>
				<div><dt>Copies omitted</dt><dd>{group.lines.length - group.selectedCount}</dd></div>
			</dl>
			<div className="field">
				<label htmlFor={id}>Copies to keep · group at line {firstLine}</label>
				<input id={id} type="number" inputMode="numeric" min={1} max={group.lines.length} step={1}
					disabled={disabled} value={Number.isNaN(count) ? '' : count} onChange={(event) => onChange(event.target.valueAsNumber)} />
			</div>
		</li>
	);
}

export function ClockifyDuplicateGroups({ groups, rows, counts, onChange, disabled }: {
	groups: DuplicateGroup[];
	rows: Map<number, ClockifyPreviewRow>;
	counts: Record<string, number>;
	onChange: (group: DuplicateGroup, count: number) => void;
	disabled: boolean;
}) {
	const [limit, setLimit] = useState(12);
	return (
		<div className="clockify-duplicate-groups">
			<h3>Identical source rows</h3>
			<p className="field-hint">Keep one copy unless the rows represent separate sessions. Previously accepted copies stay recorded.</p>
			<ul className="clockify-rows">
				{groups.slice(0, limit).map((group) => (
					<DuplicateGroupFields key={group.fingerprint} group={group} source={rows.get(group.lines[0] ?? 0)}
						count={counts[group.fingerprint] ?? group.selectedCount} onChange={(count) => onChange(group, count)} disabled={disabled} />
				))}
			</ul>
			{limit < groups.length ? <button type="button" disabled={disabled} onClick={() => setLimit(limit + 12)}>Show more identical groups</button> : null}
		</div>
	);
}
