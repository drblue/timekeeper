import { chromium } from '@playwright/test';
import { dailyBarsSvg, projectColor, projectPieSvg } from './chart-svg.js';
import { reportFormat } from './format.js';
import type { ReportFormat } from './format.js';
import type { ProjectShare, ReportData, ReportLine, ReportRenderer } from './report-data.js';

const legendOnChartPage = 6;
const inset = '15.5mm';
const css = `
	@page { size: A4 portrait; }
	* { box-sizing: border-box; }
	body {
		margin: 0;
		color: #102a43;
		font: 10pt/1.3 Arial, "Liberation Sans", sans-serif;
		overflow-wrap: anywhere;
		print-color-adjust: exact;
	}
	h1, h2, h3, p { margin: 0; }
	h1 { font-size: 36pt; line-height: 1.1; margin-bottom: 8pt; }
	h2 { font-size: 20pt; line-height: 1.2; }
	h3 { font-size: 15pt; margin-bottom: 8pt; }
	.muted { font-size: 9pt; color: #475569; }
	.eyebrow { color: #137a73; font-size: 10pt; font-weight: bold; margin-bottom: 5pt; }
	.overview-header, .scope, .totals { display: flex; gap: 12pt; }
	.overview-header { justify-content: space-between; align-items: flex-start; }
	.owner { font-size: 14pt; color: #475569; margin-bottom: 7pt; }
	.range { font-size: 12pt; }
	.logo { width: 90pt; height: 48pt; object-fit: contain; object-position: right top; }
	.scope { border-top: 1px solid #cbd5e1; margin-top: 20pt; padding: 10pt 0; }
	.scope > div, .totals > div { flex: 1; min-width: 0; }
	.totals { background: #ebf5f3; padding: 14pt; margin-bottom: 27pt; }
	.total-value { display: block; font-size: 20pt; margin-top: 3pt; }
	.pie-and-legend { display: flex; gap: 28pt; align-items: flex-start; }
	.pie { flex: 0 0 184pt; margin-top: 16pt; }
	.pie svg { display: block; width: 100%; height: auto; }
	.legend { flex: 1; min-width: 0; }
	.legend td { font-size: 9pt; padding: 5pt 0; border-bottom: .5pt solid #cbd5e1; }
	.legend td + td { padding-left: 8pt; }
	.swatch-column { width: 25pt; }
	.share-column { width: 98pt; }
	.swatch {
		display: inline-block;
		min-width: 23pt;
		padding: 1pt 2pt;
		border-radius: 2pt;
		color: white;
		font-weight: bold;
		text-align: center;
	}
	section + section { break-before: page; }
	table { width: 100%; border-collapse: collapse; table-layout: fixed; }
	thead { display: table-header-group; break-inside: avoid; }
	tr { break-inside: avoid; }
	th, td { text-align: left; vertical-align: top; padding: 0; }
	.section-heading { padding-bottom: 16pt; }
	.month { font-size: 13pt; margin-bottom: 4pt; }
	.month-panel { padding: 0 0 12pt; border-bottom: .5pt solid #cbd5e1; }
	.month-panel svg { display: block; width: 100%; height: auto; }
	tr + tr .month-panel { padding-top: 14pt; }
	.entries { font-size: 9pt; }
	.entries .labels th { padding: 6pt 4pt; background: #ebf5f3; }
	.entries td { padding: 6pt 4pt; border-bottom: .5pt solid #cbd5e1; }
	.entries .date { width: 59pt; }
	.entries .group { width: 99pt; }
	.entries .time { width: 57pt; }
	.entries .money { width: 73pt; }
	.numeric { text-align: right; font-variant-numeric: tabular-nums; }
	.description { white-space: pre-wrap; }
	tr.description-lead { break-after: avoid; }
	tr.description-lead td { border-bottom: none; }
	tr.long-description { break-inside: auto; }
	.entries .long-description td { padding-top: 0; orphans: 2; widows: 2; }
`;

function escapeHtml(value: string) {
	return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function sectionHeading(title: string, label: ReportFormat['label'], columns: number) {
	return `<tr><th class="section-heading" colspan="${columns}">
		<p class="eyebrow">${label.title}</p>
		<h2>${title}</h2>
	</th></tr>`;
}

function legend(data: ReportData, format: ReportFormat, shares: readonly ProjectShare[], start: number) {
	const rows = shares.map((share, index) => `<tr>
		<td><span class="swatch" style="background:${projectColor(start + index)}">${start + index + 1}</span></td>
		<td>${escapeHtml(share.projectName ?? format.label.noProject)}
			${share.clientName ? `<p class="muted">${escapeHtml(share.clientName)}</p>` : ''}
		</td>
		<td class="numeric">${format.duration(share.seconds)}
			<p class="muted">${format.share(share.seconds, data.totalSeconds)}</p>
		</td>
	</tr>`).join('');

	return `<table class="legend">
		<colgroup><col class="swatch-column"><col><col class="share-column"></colgroup>
		<thead>${start > 0
			? sectionHeading(format.label.legendContinued, format.label, 3)
			: `<tr><th class="eyebrow" colspan="3">${format.label.projectLegend}</th></tr>`}</thead>
		<tbody>${rows}</tbody>
	</table>`;
}

function overview(data: ReportData, format: ReportFormat, shares: readonly ProjectShare[]) {
	const { label } = format;
	const { scope } = data;
	const fields = [
		[label.client, scope.clientName ?? label.all],
		[label.project, scope.projectName ?? label.all],
		[label.billability, label[scope.billability]],
		[label.invoiceStatus, label[scope.invoiceStatus]],
	] as const;

	return `<section>
		<div class="overview-header">
			<div>
				<p class="eyebrow">${label.summary}</p>
				<h1>${label.title}</h1>
				<p class="owner">${escapeHtml(data.ownerName)}</p>
				<p class="range">${escapeHtml(scope.from)} - ${escapeHtml(scope.to)}</p>
			</div>
			${data.logo ? `<img class="logo" alt="" src="data:image/png;base64,${data.logo.toString('base64')}">` : ''}
		</div>
		<div class="scope">${fields.map(([name, value]) =>
			`<div><p class="muted">${name}</p>${escapeHtml(value)}</div>`).join('')}</div>
		<div class="totals">
			<div><p class="muted">${label.totalHours}</p>
				<strong class="total-value">${format.duration(data.totalSeconds)}</strong>
			</div>
			${data.showMoney ? `<div><p class="muted">${label.billableAmount}</p>
				<strong class="total-value">${format.money(data.totalAmountOre)}</strong>
			</div>` : ''}
		</div>
		<h3>${label.projectShares}</h3>
		${shares.length > 0 ? `<div class="pie-and-legend">
			<div class="pie">${projectPieSvg(shares, data.totalSeconds, format)}</div>
			${legend(data, format, shares.slice(0, legendOnChartPage), 0)}
		</div>` : `<p class="muted">${label.noTime}</p>`}
	</section>`;
}

function dailyHours(days: ReportData['days'], format: ReportFormat) {
	const months = Map.groupBy(days, ({ date }) => date.slice(0, 7));
	if (months.size === 0) return '';

	const panels = Array.from(months, ([month, monthDays]) => `<tr><td class="month-panel">
		<h3 class="month">${format.month(`${month}-01`)}</h3>
		${dailyBarsSvg(monthDays, format)}
	</td></tr>`).join('');
	return `<section><table>
		<thead>${sectionHeading(format.label.dailyHours, format.label, 1)}</thead>
		<tbody>${panels}</tbody>
	</table></section>`;
}

function entries(
	data: ReportData,
	format: ReportFormat,
	rows: readonly (ReportLine & { readonly date?: string })[],
	details: boolean,
) {
	const { label } = format;
	const columns = [
		...(details ? [{ name: label.date, className: 'date' }] : []),
		{ name: label.group, className: 'group' },
		{ name: label.description, className: '' },
		{ name: label.time, className: 'time', numeric: true },
		...(data.showMoney ? [
			{ name: label.hourlyRate, className: 'money', numeric: true },
			{ name: label.amount, className: 'money', numeric: true },
		] : []),
	];

	const body = rows.map((row) => {
		const long = row.description.length > 400 || row.description.split('\n').length > 5;
		const description = escapeHtml(row.description);
		return `<tr${long ? ' class="description-lead"' : ''}>
			${details ? `<td>${escapeHtml(row.date ?? '')}</td>` : ''}
			<td>${row.clientName ? `<p>${escapeHtml(row.clientName)}</p>` : ''}
				<p>${escapeHtml(row.projectName ?? label.noProject)}</p>
			</td>
			<td class="description">${long ? '' : description}</td>
			<td class="numeric">${format.duration(row.seconds)}</td>
			${data.showMoney ? `<td class="numeric">${row.hourlyRateOre === null ? '-' : format.money(row.hourlyRateOre)}</td>
				<td class="numeric">${format.money(row.amountOre)}</td>` : ''}
		</tr>${long ? `<tr class="long-description"><td colspan="${columns.length}">
			<p class="description">${description}</p>
		</td></tr>` : ''}`;
	}).join('');

	return `<section><table class="entries">
		<colgroup>${columns.map(({ className }) => `<col class="${className}">`).join('')}</colgroup>
		<thead>
			${sectionHeading(details ? label.details : label.descriptionSummaries, label, columns.length)}
			<tr class="labels">${columns.map(({ name, numeric }) =>
				`<th scope="col"${numeric ? ' class="numeric"' : ''}>${name}</th>`).join('')}</tr>
		</thead>
		<tbody>${body || `<tr><td colspan="${columns.length}">${label.noTime}</td></tr>`}</tbody>
	</table></section>`;
}

function documentHtml(data: ReportData, format: ReportFormat) {
	const shares = data.projectShares.filter(({ seconds }) => seconds > 0);
	return `<!doctype html><html lang="${data.language}">
		<head>
			<meta charset="utf-8">
			<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
			<title>${format.label.title}</title>
			<style>${css}</style>
		</head>
		<body>
			${overview(data, format, shares)}
			${shares.length > legendOnChartPage
				? `<section>${legend(data, format, shares.slice(legendOnChartPage), legendOnChartPage)}</section>` : ''}
			${dailyHours(data.days, format)}
			${entries(data, format, data.summaries, false)}
			${data.details ? entries(data, format, data.details, true) : ''}
		</body>
	</html>`;
}

function footerHtml(data: ReportData, format: ReportFormat) {
	return `<div style="width:100%; margin:0 ${inset}; padding-top:8pt; border-top:.5pt solid #cbd5e1;
		display:flex; justify-content:space-between; color:#475569; font:8pt Arial, sans-serif">
		<span>${escapeHtml(data.scope.from)} - ${escapeHtml(data.scope.to)}</span>
		<span>${format.label.page} <span class="pageNumber"></span> / <span class="totalPages"></span></span>
	</div>`;
}

export function launchReportChromium() {
	return chromium.launch({
		chromiumSandbox: true,
		executablePath: process.env.PDF_CHROMIUM_EXECUTABLE_PATH,
	});
}

export const renderHtmlPdf: ReportRenderer = async (data) => {
	const format = reportFormat(data.language);
	const browser = await launchReportChromium();
	try {
		const page = await browser.newPage({ offline: true, javaScriptEnabled: false, serviceWorkers: 'block' });
		await page.setContent(documentHtml(data, format), { waitUntil: 'load' });
		await page.evaluate('document.fonts.ready.then(() => undefined)');
		return await page.pdf({
			preferCSSPageSize: true,
			printBackground: true,
			displayHeaderFooter: true,
			headerTemplate: '<div></div>',
			footerTemplate: footerHtml(data, format),
			margin: { top: '15mm', right: inset, bottom: '21mm', left: inset },
		});
	} finally {
		await browser.close();
	}
};
