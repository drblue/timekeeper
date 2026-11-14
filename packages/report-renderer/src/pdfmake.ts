import pdfmake from 'pdfmake';
import type {
	Column, Content, ContentSection, ContentText, CustomTableLayout, TableCell, TDocumentDefinitions,
} from 'pdfmake/interfaces.js';
import { dailyBarsSvg, projectColor, projectPieSvg } from './chart-svg.js';
import { reportFormat } from './format.js';
import type { ReportFormat } from './format.js';
import type { ProjectShare, ReportData, ReportLine, ReportRenderer } from './report-data.js';

const inset = 44;
const contentWidth = 507;
const ink = '#102a43';
const muted = '#475569';
const accent = '#137a73';
const line = '#cbd5e1';
const tint = '#ebf5f3';
const firstLegendRows = 6;

// The pinned release provides these server-side methods ahead of its type definitions.
declare module 'pdfmake' {
	export function setLocalAccessPolicy(allow: (path: string) => boolean): void;
	export function setUrlAccessPolicy(allow: (url: string) => boolean): void;
}

const helvetica = {
	normal: 'Helvetica',
	bold: 'Helvetica-Bold',
	italics: 'Helvetica-Oblique',
	bolditalics: 'Helvetica-BoldOblique',
};
pdfmake.addFonts({ Helvetica: helvetica });
pdfmake.setLocalAccessPolicy((path) => Object.values(helvetica).includes(path));
pdfmake.setUrlAccessPolicy(() => false);

const rowLayout: CustomTableLayout = {
	hLineWidth: (index) => index === 0 ? 0 : 0.5,
	hLineColor: line,
	vLineWidth: () => 0,
	paddingLeft: () => 4,
	paddingRight: () => 4,
	paddingTop: () => 5,
	paddingBottom: () => 5,
};

function wrappedText(value: string): ContentText['text'] {
	const parts = value.split(/(\S{18,})/u);
	if (parts.length === 1) return value;
	return parts.map((text, index) => index % 2 ? { text, wordBreak: 'break-all' } : text);
}

function rule(): Content {
	return { canvas: [{ type: 'line', x1: 0, y1: 0, x2: contentWidth, y2: 0, lineWidth: 0.6, lineColor: line }] };
}

function section(reportTitle: string, sectionTitle: string, content: Content): ContentSection {
	return {
		pageMargins: [inset, 107, inset, 63],
		header: {
			margin: [inset, 43, inset, 0],
			stack: [
				{ text: reportTitle, style: 'eyebrow' },
				{ text: sectionTitle, fontSize: 20, bold: true },
			],
		},
		section: content,
	};
}

function legend(shares: readonly ProjectShare[], start: number, total: number, format: ReportFormat): Content {
	const body = shares.map((share, index): TableCell[] => [
		{
			fillColor: projectColor(start + index),
			text: String(start + index + 1),
			alignment: 'center',
			bold: true,
			color: '#ffffff',
			fontSize: 8,
		},
		{
			stack: [
				{ text: wrappedText(share.displayName ?? share.projectName ?? format.label.noProject) },
				...(share.clientName ? [{ text: wrappedText(share.clientName), color: muted }] : []),
			],
		},
		{
			stack: [
				{ text: format.duration(share.seconds) },
				{ text: format.share(share.seconds, total), color: muted },
			],
			alignment: 'right',
		},
	]);
	return {
		table: { widths: [15, '*', 74], body, dontBreakRows: true },
		layout: rowLayout,
		fontSize: 9,
	};
}

function overview(data: ReportData, shares: readonly ProjectShare[], format: ReportFormat): Content {
	const { label } = format;
	const { scope } = data;
	const scopeFields: [string, string][] = [
		[label.client, scope.clientName ?? label.all],
		[label.project, scope.projectName ?? label.all],
		[label.billability, label[scope.billability]],
		[label.invoiceStatus, label[scope.invoiceStatus]],
	];
	const searches = [
		{ name: label.description, value: scope.description },
		{ name: label.invoiceNumber, value: scope.invoiceNumber },
	].flatMap(({ name, value }) => value ? [{ text: wrappedText(name + ' · ' + value), margin: [0, 0, 0, 4] } satisfies Content] : []);
	const totals: [string, string][] = [[label.totalHours, format.duration(data.totalSeconds)]];
	if (data.showMoney) totals.push([label.billableAmount, format.money(data.totalAmountOre)]);

	const intro: Column = {
		width: '*',
		stack: [
			{ text: label.summary, style: 'eyebrow' },
			{ text: label.title, bold: true, fontSize: 36, margin: [0, 0, 0, 8] },
			{ text: wrappedText(data.ownerName), color: muted, fontSize: 14, margin: [0, 0, 0, 7] },
			{ text: `${scope.from} - ${scope.to}`, fontSize: 12 },
		],
	};
	const logoFormat = data.logo?.[0] === 0xff ? 'jpeg' : 'png';
	const columns: Column[] = [intro];
	if (data.logo) columns.push({
		width: 90,
		stack: [{
			image: `data:image/${logoFormat};base64,${data.logo.toString('base64')}`,
			fit: [90, 48],
			alignment: 'right',
		}],
	});
	const scopeBlock: Content = {
		columns: scopeFields.map(([title, value]) => ({
			width: '*',
			stack: [{ text: title, style: 'muted' }, { text: wrappedText(value) }],
		})),
		columnGap: 12,
		margin: [0, 10, 0, 10],
	};
	const totalsBlock: Content = {
		table: {
			widths: totals.map(() => '*'),
			body: [totals.map(([title, value]) => ({
				stack: [
					{ text: title, style: 'muted' },
					{ text: value, bold: true, fontSize: 20, margin: [0, 3, 0, 0] },
				],
				fillColor: tint,
			}))],
		},
		layout: {
			hLineWidth: () => 0,
			vLineWidth: () => 0,
			paddingTop: () => 12,
			paddingBottom: () => 12,
			paddingLeft: () => 14,
			paddingRight: () => 14,
		},
		margin: [0, 0, 0, 27],
	};
	const chart: Content = shares.length ? {
		columns: [
			{ svg: projectPieSvg(shares, data.totalSeconds, format), width: 184, margin: [0, 17, 0, 0] },
			{
				width: '*',
				stack: [
					{ text: label.projectLegend, bold: true, color: accent, margin: [0, 0, 0, 5] },
					legend(shares.slice(0, firstLegendRows), 0, data.totalSeconds, format),
				],
			},
		],
		columnGap: 28,
	} : { text: label.noTime, style: 'muted' };

	return {
		stack: [
			{ columns, columnGap: 14, margin: [0, 0, 0, 20] },
			rule(),
			scopeBlock,
			...searches,
			totalsBlock,
			{ text: label.projectShares, fontSize: 15, bold: true, margin: [0, 0, 0, 11] },
			chart,
		],
	};
}

type DatedLine = ReportLine & { readonly date?: string };

function reportTable(
	data: ReportData, rows: readonly DatedLine[], format: ReportFormat, details: boolean,
): Content {
	const { label } = format;
	const widths = [...(details ? [51] : []), 94, '*' as const, 53, ...(data.showMoney ? [73, 73] : [])];
	const headings = [
		...(details ? [label.date] : []),
		label.group, label.description, label.time,
		...(data.showMoney ? [label.hourlyRate, label.amount] : []),
	];
	const header: TableCell[] = headings.map((text, index) => ({
		text,
		bold: true,
		alignment: index >= (details ? 3 : 2) ? 'right' : 'left',
		fillColor: tint,
	}));
	const body = [header];
	let hasLongDescription = false;
	for (const row of rows) {
		// A full-width continuation keeps long text legible and lets it flow across pages.
		const long = row.description.length > 400 || row.description.split('\n').length > 5;
		const cells: TableCell[] = [
			...(details ? [{ text: row.date ?? '' }] : []),
			{ text: wrappedText(row.groupLabel ?? [row.clientName, row.projectName ?? label.noProject].filter(Boolean).join('\n')) },
			{ text: long ? '' : wrappedText(row.description) },
			{ text: format.duration(row.seconds), alignment: 'right' },
		];
		if (data.showMoney) cells.push(
			{ text: row.hourlyRateOre === null ? '-' : format.money(row.hourlyRateOre), alignment: 'right' },
			{ text: format.money(row.amountOre), alignment: 'right' },
		);
		body.push(cells);
		if (long) {
			hasLongDescription = true;
			body.push([
				{
					text: wrappedText(row.description),
					colSpan: widths.length,
				},
				...widths.slice(1).map(() => ({})),
			]);
		}
	}
	if (!rows.length) {
		body.push([{ text: label.noTime, colSpan: widths.length }, ...widths.slice(1).map(() => ({}))]);
	}
	return {
		table: {
			widths,
			body,
			headerRows: 1,
			keepWithHeaderRows: 1,
			dontBreakRows: !hasLongDescription,
		},
		layout: rowLayout,
		fontSize: 8.5,
		lineHeight: 1.2,
	};
}

function document(data: ReportData): TDocumentDefinitions {
	const format = reportFormat(data.language, data.numberLocale);
	const { label } = format;
	const shares = data.projectShares.filter(({ seconds }) => seconds > 0);
	const months = Map.groupBy(data.days, ({ date }) => date.slice(0, 7));
	const content: Content[] = [overview(data, shares, format)];
	if (shares.length > firstLegendRows) {
		content.push(section(
			label.title, label.legendContinued,
			legend(shares.slice(firstLegendRows), firstLegendRows, data.totalSeconds, format),
		));
	}
	if (months.size) {
		const panels: Content[] = [...months].map(([month, days]) => ({
			stack: [
				{ text: format.month(`${month}-01`), bold: true, fontSize: 13, margin: [0, 0, 0, 4] },
				{ svg: dailyBarsSvg(days, format) },
				rule(),
			],
			unbreakable: true,
			margin: [0, 0, 0, 21],
		}));
		content.push(section(label.title, label.dailyHours, panels));
	}
	content.push(section(label.title, label.descriptionSummaries, reportTable(data, data.summaries, format, false)));
	if (data.details) {
		content.push(section(label.title, label.details, reportTable(data, data.details, format, true)));
	}
	return {
		info: { title: label.title, author: data.ownerName },
		pageSize: 'A4',
		language: data.language,
		pageMargins: [inset, 43, inset, 63],
		defaultStyle: { font: 'Helvetica', color: ink, fontSize: 10 },
		styles: {
			eyebrow: { color: accent, bold: true, margin: [0, 0, 0, 6] },
			muted: { color: muted, fontSize: 9 },
		},
		footer: (page, pageCount) => ({
			margin: [inset, 18, inset, 0],
			stack: [
				rule(),
				{
					columns: [
						{ text: `${data.scope.from} - ${data.scope.to}` },
						{ text: `${label.page} ${page} / ${pageCount}`, alignment: 'right' },
					],
					color: muted,
					fontSize: 8,
					margin: [0, 8, 0, 0],
				},
			],
		}),
		content,
	};
}

export const renderPdfmakeReport: ReportRenderer = (data) => pdfmake.createPdf(document(data)).getBuffer();
