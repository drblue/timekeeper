import { Circle, G, Line, Path, Rect, Svg, Text } from '@react-pdf/renderer';
import type { ReportFormat } from './format.js';
import type { ProjectShare, ReportData } from './report-data.js';

const TAU = 2 * Math.PI;
const pieCenter = 92;
const pieRadius = 89;

function polar(radius: number, angle: number) {
	return {
		x: pieCenter + radius * Math.sin(angle),
		y: pieCenter - radius * Math.cos(angle),
	};
}

export function projectColor(index: number) {
	const hue = Math.round((index * 137.508 + 173) % 360);
	const lightness = 31 + (Math.floor(index / 12) % 3) * 7;
	return `hsl(${hue}, 56%, ${lightness}%)`;
}

export function ProjectPie({ shares, total, format }: {
	shares: readonly ProjectShare[];
	total: number;
	format: ReportFormat;
}) {
	if (shares.length === 1) {
		return (
			<Svg width={184} height={184}>
				<Circle cx={pieCenter} cy={pieCenter} r={pieRadius} fill={projectColor(0)} />
				<Text x={pieCenter} y={98} textAnchor="middle" fill="#ffffff" style={{ fontSize: 23 }}>
					{format.share(total, total)}
				</Text>
			</Svg>
		);
	}

	let previous = 0;
	return (
		<Svg width={184} height={184}>
			{shares.map(({ projectId, seconds }, index) => {
				const angle = TAU * previous / total;
				previous += seconds;
				const nextAngle = TAU * previous / total;
				const start = polar(pieRadius, angle);
				const end = polar(pieRadius, nextAngle);
				const largeArc = nextAngle - angle > Math.PI ? 1 : 0;
				const label = polar(62, (angle + nextAngle) / 2);
				const share = seconds / total;
				return (
					<G key={projectId ?? 'no-project'}>
						<Path
							fill={projectColor(index)}
							d={`M ${pieCenter} ${pieCenter} L ${start.x} ${start.y} A ${pieRadius} ${pieRadius} 0 ${largeArc} 1 ${end.x} ${end.y} Z`}
						/>
						{share >= 0.04 && (
							<Text x={label.x} y={label.y + 3} textAnchor="middle" fill="#ffffff" style={{ fontSize: 8 }}>
								{share >= 0.11 ? format.share(seconds, total) : String(index + 1)}
							</Text>
						)}
					</G>
				);
			})}
		</Svg>
	);
}

export function DailyBars({ days, format }: { days: ReportData['days']; format: ReportFormat }) {
	const width = 507;
	const left = 31;
	const plotWidth = width - left - 4;
	const height = 84;
	const top = 13;
	const baseline = top + height;
	const maxHours = Math.max(1, Math.ceil(Math.max(...days.map((day) => day.seconds)) / 3600));
	const dayWidth = plotWidth / days.length;

	return (
		<Svg width={width} height={116}>
			{[maxHours, maxHours / 2, 0].map((hours) => {
				const y = baseline - (height * hours / maxHours);
				return (
					<G key={hours}>
						<Line x1={left} x2={width - 4} y1={y} y2={y} stroke="#cbd5e1" strokeWidth={0.6} />
						<Text x={left - 4} y={y + 2.5} textAnchor="end" fill="#475569" style={{ fontSize: 7 }}>
							{`${format.decimal(hours)} h`}
						</Text>
					</G>
				);
			})}
			{days.map(({ date, seconds }, index) => {
				const x = left + (index + 0.5) * dayWidth;
				const barHeight = height * seconds / 3600 / maxHours;
				return (
					<G key={date}>
						{seconds > 0 ? (
							<Rect x={x - dayWidth * 0.31} y={baseline - barHeight} width={dayWidth * 0.62}
								height={barHeight} fill="#137a73" />
						) : (
							<Circle cx={x} cy={baseline} r={0.85} fill="#64748b" />
						)}
						<Text x={x} y={baseline + 12} textAnchor="middle" fill="#334155" style={{ fontSize: 7.2 }}>
							{date.slice(-2)}
						</Text>
					</G>
				);
			})}
		</Svg>
	);
}
