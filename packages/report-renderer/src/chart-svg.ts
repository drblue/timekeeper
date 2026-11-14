import type { ReportFormat } from './format.js';
import type { ProjectShare, ReportData } from './report-data.js';

const pieCenter = 92;
const pieRadius = 89;
const fullTurn = 2 * Math.PI;

function svg(width: number, height: number, children: string) {
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${children}</svg>`;
}

function text(x: number, y: number, value: string, size: number, color: string, anchor = 'middle') {
	// Callers supply only numbers and their localized representations.
	return `<text x="${x}" y="${y}" text-anchor="${anchor}" font-family="Helvetica" font-size="${size}" fill="${color}">${value}</text>`;
}

function polar(radius: number, angle: number) {
	return {
		x: pieCenter + radius * Math.sin(angle),
		y: pieCenter - radius * Math.cos(angle),
	};
}

export function projectColor(index: number) {
	// Match the palette used by the React PDF baseline.
	const hue = Math.round((index * 137.508 + 173) % 360);
	const lightness = (31 + (Math.floor(index / 12) % 3) * 7) / 100;
	const chroma = 0.56 * Math.min(lightness, 1 - lightness);
	const channel = (offset: number) => {
		const phase = (offset + hue / 30) % 12;
		const value = lightness - chroma * Math.max(-1, Math.min(phase - 3, 9 - phase, 1));
		return Math.round(255 * value).toString(16).padStart(2, '0');
	};
	return `#${channel(0)}${channel(8)}${channel(4)}`;
}

export function projectPieSvg(shares: readonly ProjectShare[], total: number, format: ReportFormat) {
	if (shares.length === 1) {
		const circle = `<circle cx="${pieCenter}" cy="${pieCenter}" r="${pieRadius}" fill="${projectColor(0)}"/>`;
		const label = text(pieCenter, 98, format.share(total, total), 23, '#ffffff');
		return svg(184, 184, circle + label);
	}

	let previous = 0;
	const wedges = shares.map(({ seconds }, index) => {
		const angle = fullTurn * previous / total;
		previous += seconds;
		const nextAngle = fullTurn * previous / total;
		const start = polar(pieRadius, angle);
		const end = polar(pieRadius, nextAngle);
		const largeArc = nextAngle - angle > Math.PI ? 1 : 0;
		const path = `M ${pieCenter} ${pieCenter} L ${start.x} ${start.y} A ${pieRadius} ${pieRadius} 0 ${largeArc} 1 ${end.x} ${end.y} Z`;
		const wedge = `<path d="${path}" fill="${projectColor(index)}"/>`;
		const share = seconds / total;
		if (share < 0.04) return wedge;
		const { x, y } = polar(62, (angle + nextAngle) / 2);
		const value = share >= 0.11 ? format.share(seconds, total) : String(index + 1);
		return wedge + text(x, y + 3, value, 8, '#ffffff');
	});
	return svg(184, 184, wedges.join(''));
}

export function dailyBarsSvg(days: ReportData['days'], format: ReportFormat) {
	const width = 507;
	const left = 31;
	const right = width - 4;
	const height = 84;
	const baseline = 97;
	const maxHours = Math.max(1, Math.ceil(Math.max(...days.map(({ seconds }) => seconds)) / 3600));
	const dayWidth = (right - left) / days.length;

	const ticks = [maxHours, maxHours / 2, 0].map((hours) => {
		const y = baseline - (height * hours / maxHours);
		return `<line x1="${left}" x2="${right}" y1="${y}" y2="${y}" stroke="#cbd5e1" stroke-width="0.6"/>`
			+ text(left - 4, y + 2.5, `${format.decimal(hours)} h`, 7, '#475569', 'end');
	});
	const bars = days.map(({ date, seconds }, index) => {
		const x = left + (index + 0.5) * dayWidth;
		const barHeight = height * seconds / 3600 / maxHours;
		const mark = seconds > 0
			? `<rect x="${x - dayWidth * 0.31}" y="${baseline - barHeight}" width="${dayWidth * 0.62}" height="${barHeight}" fill="#137a73"/>`
			: `<circle cx="${x}" cy="${baseline}" r="0.85" fill="#64748b"/>`;
		return mark + text(x, baseline + 12, date.slice(-2), 7.2, '#334155');
	});
	return svg(width, 116, [...ticks, ...bars].join(''));
}
