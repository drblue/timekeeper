import type { ReportPreviewResponse } from '@timekeeper/contracts';
import { useId, useState } from 'react';
import { formatDuration } from './entry-display';
import { reportIdentityLabels } from './report-labels';

type Day = ReportPreviewResponse['days'][number];
type Project = ReportPreviewResponse['projectShares'][number];

const monthFormat = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const dayFormat = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const percent = new Intl.NumberFormat('en-GB', { style: 'percent', maximumFractionDigits: 2 });

function chartDate(date: string) {
	return new Date(date + 'T00:00:00Z');
}

function monthLabel(month: string) {
	return monthFormat.format(chartDate(month + '-01'));
}

export function DailyReportChart({ days }: { days: Day[] }) {
	const heading = useId();
	const months = new Map<string, Day[]>();
	let maximum = 0;
	for (const day of days) {
		const month = day.date.slice(0, 7);
		const bucket = months.get(month);
		if (bucket) bucket.push(day);
		else months.set(month, [day]);
		maximum = Math.max(maximum, day.seconds);
	}
	const [chosenMonth, setChosenMonth] = useState('');
	const month = months.has(chosenMonth) ? chosenMonth : months.keys().next().value;
	const current = month ? months.get(month) ?? [] : [];
	// Choose a readable ceiling without rounding the values or obscuring short durations.
	const unit = maximum > 3600 ? 3600 : maximum > 60 ? 60 : 1;
	const ceiling = maximum ? Math.ceil(maximum / unit) * unit : 3600;
	return (
		<section className="panel report-section" aria-labelledby={heading}>
			<div className="catalog-toolbar">
				<h2 id={heading}>Daily hours</h2>
				{months.size > 1 ? (
					<div className="field report-month-field">
						<label htmlFor={heading + '-month'}>Month</label>
						<select id={heading + '-month'} value={month} onChange={(event) => setChosenMonth(event.target.value)}>
							{Array.from(months.keys(), (key) => <option key={key} value={key}>{monthLabel(key)}</option>)}
						</select>
					</div>
				) : month ? <p className="field-hint">{monthLabel(month)}</p> : null}
			</div>
			<div className="report-daily-chart" aria-hidden="true">
				<div className="report-daily-scale"><span>{formatDuration(ceiling)}</span><span>0</span></div>
				<div className="report-daily-plot">
					<div className="report-daily-bars">
						{current.map((day) => (
							<div key={day.date} title={dayFormat.format(chartDate(day.date)) + ' · ' + formatDuration(day.seconds)}>
								<span className="report-daily-bar" style={{ blockSize: (day.seconds / ceiling * 100) + '%', minBlockSize: day.seconds ? '1px' : 0 }} />
							</div>
						))}
					</div>
					<div className="report-daily-labels">
						{current.map((day, index) => {
							const dayOfMonth = Number(day.date.slice(8));
							return <span key={day.date}>{index === 0 || (dayOfMonth % 5 === 0 && index > 1) ? dayOfMonth : ''}</span>;
						})}
					</div>
				</div>
			</div>
			{current.length ? (
				<details className="report-daily-values">
					<summary>View daily values</summary>
					<table className="report-table">
						<thead><tr><th scope="col">Date</th><th scope="col">Duration</th></tr></thead>
						<tbody>{current.map((day) => (
							<tr key={day.date}><th scope="row"><time dateTime={day.date}>{dayFormat.format(chartDate(day.date))}</time></th>
								<td>{formatDuration(day.seconds)}</td></tr>
						))}</tbody>
					</table>
				</details>
			) : null}
		</section>
	);
}

const pieColors = ['#216052', '#386990', '#99602e', '#76558d', '#276d70', '#8c4b59', '#596a35', '#66584c'];
function shareLabel(share: number) {
	if (share < 0.0001) return '<0.01%';
	if (share > 0.9999 && share < 1) return '>99.99%';
	return percent.format(share);
}

const pieRadius = 48;
const center = 50;
function piePoint(turn: number) {
	const angle = (turn - 0.25) * Math.PI * 2;
	return [center + pieRadius * Math.cos(angle), center + pieRadius * Math.sin(angle)] as const;
}

export function ProjectReportChart({ projects, totalSeconds }: { projects: Project[]; totalSeconds: number }) {
	const heading = useId();
	const present = projects.filter((project) => project.seconds > 0);
	const projectLabel = reportIdentityLabels(
		present, (project) => project.projectName ?? 'No project', (project) => project.projectId ?? '',
	);
	let cumulative = 0;
	const slices = present.map((project, index) => {
		const start = cumulative / totalSeconds;
		cumulative += project.seconds;
		const end = cumulative / totalSeconds;
		return { project, share: project.seconds / totalSeconds, start, end, color: pieColors[index % pieColors.length] };
	});
	return (
		<section className="panel report-section" aria-labelledby={heading}>
			<h2 id={heading}>Time by project</h2>
			{totalSeconds > 0 && slices.length ? (
				<div className="report-project-layout">
					<svg className="report-pie" viewBox="0 0 100 100" aria-hidden="true">
						{slices.length === 1 ? (
							<>
								<circle cx={center} cy={center} r={pieRadius} fill={slices[0]?.color} />
								<text x={center} y={center} className="report-pie-full-label">100%</text>
							</>
						) : slices.map(({ project, share, start, end, color }, index) => {
							const [x1, y1] = piePoint(start);
							const [x2, y2] = piePoint(end);
							const [labelX, labelY] = piePoint((start + end) / 2);
							return (
								<g key={project.projectId ?? 'none'}>
									<path d={`M ${center} ${center} L ${x1} ${y1} A ${pieRadius} ${pieRadius} 0 ${share > 0.5 ? 1 : 0} 1 ${x2} ${y2} Z`} fill={color} />
									{share >= 0.06 ? <text x={center + (labelX - center) * 0.69}
										y={center + (labelY - center) * 0.69}>{index + 1}</text> : null}
								</g>
							);
						})}
					</svg>
					<ol className="report-project-legend" aria-label="Project duration and share">
						{slices.map(({ project, share, color }, index) => (
							<li key={project.projectId ?? 'none'}>
								<span className="report-project-number" style={{ backgroundColor: color }} aria-hidden="true">{index + 1}</span>
								<span className="report-project-name">
									<strong>{projectLabel(project)}</strong>
									{project.clientName ? <span className="field-hint">{project.clientName}</span> : null}
								</span>
								<span>{formatDuration(project.seconds)}</span>
								<strong>{shareLabel(share)}</strong>
							</li>
						))}
					</ol>
				</div>
			) : <p className="catalog-empty">No time recorded in this range.</p>}
		</section>
	);
}
