import {
	Document, Font, Image, Page, StyleSheet, Text, View, renderToBuffer,
} from '@react-pdf/renderer';
import type { ReactNode } from 'react';
import { DailyBars, ProjectPie, projectColor } from './charts.js';
import { reportFormat } from './format.js';
import type { ReportFormat } from './format.js';
import type { ProjectShare, ReportData, ReportLine, ReportRenderer } from './report-data.js';

const ink = '#102a43';
const muted = '#475569';
const line = '#cbd5e1';
const accent = '#137a73';
const pageInset = 44;
const legendOnChartPage = 6;
const rowsPerBatch = 72;

// Retain normal word breaks and add break opportunities to exceptionally long tokens.
Font.registerHyphenationCallback((word) => (
	word.length > 15 ? word.match(/.{1,12}/gsu) ?? [word] : [word]
));

const styles = StyleSheet.create({
	page: { paddingTop: 107, paddingBottom: 63, paddingHorizontal: pageInset, color: ink, fontSize: 10 },
	overviewPage: { paddingTop: 43 },
	header: { position: 'absolute', top: 43, left: pageInset, right: pageInset },
	eyebrow: { fontSize: 10, color: accent, fontFamily: 'Helvetica-Bold', marginBottom: 6 },
	sectionTitle: { fontSize: 20, fontFamily: 'Helvetica-Bold' },
	footer: {
		position: 'absolute', bottom: 29, left: pageInset, right: pageInset,
		flexDirection: 'row', justifyContent: 'space-between', borderTopWidth: 0.6,
		borderTopColor: line, paddingTop: 9, fontSize: 8, color: muted,
	},
	intro: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
	introText: { flex: 1, marginRight: 14 },
	title: { fontSize: 36, fontFamily: 'Helvetica-Bold', marginBottom: 8 },
	owner: { color: muted, fontSize: 14, marginBottom: 7 },
	dateRange: { fontSize: 12 },
	logo: { width: 90, height: 48, objectFit: 'contain', objectPosition: 'right top' },
	scope: {
		marginTop: 20, borderTopWidth: 0.6, borderTopColor: line,
		paddingVertical: 10, flexDirection: 'row', gap: 12,
	},
	scopeField: { flex: 1, lineHeight: 1.27 },
	muted: { color: muted, fontSize: 9 },
	totals: { backgroundColor: '#ebf5f3', padding: 14, flexDirection: 'row', marginBottom: 29 },
	total: { flex: 1 },
	totalValue: { fontSize: 20, marginTop: 3, fontFamily: 'Helvetica-Bold' },
	blockTitle: { fontSize: 15, fontFamily: 'Helvetica-Bold', marginBottom: 11 },
	pieAndLegend: { flexDirection: 'row', gap: 28 },
	pie: { width: 184, marginTop: 17 },
	legend: { flex: 1 },
	legendTitle: { color: accent, fontFamily: 'Helvetica-Bold', marginBottom: 4 },
	legendRow: {
		flexDirection: 'row', gap: 8, alignItems: 'flex-start', paddingVertical: 5,
		borderBottomWidth: 0.5, borderBottomColor: line,
	},
	swatch: { borderRadius: 2, width: 23, marginTop: 1, paddingVertical: 2, alignItems: 'center' },
	swatchText: { fontFamily: 'Helvetica-Bold', color: '#ffffff', fontSize: 8 },
	legendName: { flex: 1, fontSize: 9, lineHeight: 1.24 },
	legendNumbers: { width: 96, fontSize: 8.5, textAlign: 'right', lineHeight: 1.24 },
	panel: { marginBottom: 21, borderBottomWidth: 0.6, borderBottomColor: line },
	month: { fontSize: 13, fontFamily: 'Helvetica-Bold', marginBottom: 4 },
	tablePage: { paddingTop: 139 },
	tableHeader: {
		position: 'absolute', top: 107, left: pageInset, right: pageInset,
		paddingHorizontal: 4, paddingVertical: 7, backgroundColor: '#ebf5f3',
		fontFamily: 'Helvetica-Bold', fontSize: 8.5,
	},
	tableRow: {
		paddingVertical: 6, paddingHorizontal: 4, fontSize: 8.5, lineHeight: 1.32,
		borderBottomWidth: 0.5, borderBottomColor: line,
	},
	longDescription: { marginTop: 4, marginBottom: 5 },
	cells: { flexDirection: 'row', gap: 8 },
	date: { width: 51 },
	group: { width: 94 },
	description: { flex: 1 },
	time: { width: 53, textAlign: 'right' },
	money: { width: 73, textAlign: 'right' },
});

function Footer({ data, format }: { data: ReportData; format: ReportFormat }) {
	return (
		<View style={styles.footer} fixed>
			<Text>{data.scope.from} - {data.scope.to}</Text>
			<Text render={({ pageNumber, totalPages }) => `${format.label.page} ${pageNumber} / ${totalPages}`} />
		</View>
	);
}

function SectionPage({ children, data, format, title, table = false }: {
	children: ReactNode;
	data: ReportData;
	format: ReportFormat;
	title: string;
	table?: boolean;
}) {
	return (
		<Page size="A4" style={table ? [styles.page, styles.tablePage] : styles.page}>
			<View style={styles.header} fixed>
				<Text style={styles.eyebrow}>{format.label.title}</Text>
				<Text style={styles.sectionTitle}>{title}</Text>
			</View>
			{children}
			<Footer data={data} format={format} />
		</Page>
	);
}

function LegendRows({ data, format, shares, start }: {
	data: ReportData;
	format: ReportFormat;
	shares: readonly ProjectShare[];
	start: number;
}) {
	return shares.map((share, index) => (
		<View key={share.projectId ?? 'no-project'} style={styles.legendRow} wrap={false}>
			<View style={[styles.swatch, { backgroundColor: projectColor(index + start) }]}>
				<Text style={styles.swatchText}>{index + start + 1}</Text>
			</View>
			<View style={styles.legendName}>
				<Text>{share.projectName ?? format.label.noProject}</Text>
				{share.clientName && <Text style={styles.muted}>{share.clientName}</Text>}
			</View>
			<View style={styles.legendNumbers}>
				<Text>{format.duration(share.seconds)}</Text>
				<Text style={styles.muted}>{format.share(share.seconds, data.totalSeconds)}</Text>
			</View>
		</View>
	));
}

function Overview({ data, format, shares }: {
	data: ReportData;
	format: ReportFormat;
	shares: readonly ProjectShare[];
}) {
	const { label } = format;
	const { scope } = data;
	const scopeFields = [
		[label.client, scope.clientName ?? label.all],
		[label.project, scope.projectName ?? label.all],
		[label.billability, label[scope.billability]],
		[label.invoiceStatus, label[scope.invoiceStatus]],
	];
	return (
		<Page size="A4" style={[styles.page, styles.overviewPage]}>
			<View style={styles.intro}>
				<View style={styles.introText}>
					<Text style={styles.eyebrow}>{label.summary}</Text>
					<Text style={styles.title}>{label.title}</Text>
					<Text style={styles.owner}>{data.ownerName}</Text>
					<Text style={styles.dateRange}>{scope.from} - {scope.to}</Text>
				</View>
				{data.logo && <Image src={data.logo} style={styles.logo} />}
			</View>
			<View style={styles.scope}>
				{scopeFields.map(([field, value]) => (
					<View key={field} style={styles.scopeField}>
						<Text style={styles.muted}>{field}</Text>
						<Text>{value}</Text>
					</View>
				))}
			</View>
			<View style={styles.totals}>
				<View style={styles.total}>
					<Text style={styles.muted}>{label.totalHours}</Text>
					<Text style={styles.totalValue}>{format.duration(data.totalSeconds)}</Text>
				</View>
				{data.showMoney && (
					<View style={styles.total}>
						<Text style={styles.muted}>{label.billableAmount}</Text>
						<Text style={styles.totalValue}>{format.money(data.totalAmountOre)}</Text>
					</View>
				)}
			</View>
			<Text style={styles.blockTitle}>{label.projectShares}</Text>
			{shares.length > 0 ? (
				<View style={styles.pieAndLegend}>
					<View style={styles.pie}>
						<ProjectPie shares={shares} total={data.totalSeconds} format={format} />
					</View>
					<View style={styles.legend}>
						<Text style={styles.legendTitle}>{label.projectLegend}</Text>
						<LegendRows data={data} format={format} shares={shares.slice(0, legendOnChartPage)} start={0} />
					</View>
				</View>
			) : <Text style={styles.muted}>{label.noTime}</Text>}
			<Footer data={data} format={format} />
		</Page>
	);
}

type TableRow = ReportLine & { readonly date?: string };

function TableCells({ row, data, format, details, description }: {
	row: TableRow;
	data: ReportData;
	format: ReportFormat;
	details: boolean;
	description?: string;
}) {
	return (
		<>
			{details && <Text style={styles.date}>{row.date}</Text>}
			<Text style={styles.group}>
				{[row.clientName, row.projectName ?? format.label.noProject].filter(Boolean).join('\n')}
			</Text>
			<Text style={styles.description}>{description}</Text>
			<Text style={styles.time}>{format.duration(row.seconds)}</Text>
			{data.showMoney && (
				<Text style={styles.money}>
					{row.hourlyRateOre === null ? '-' : format.money(row.hourlyRateOre)}
				</Text>
			)}
			{data.showMoney && <Text style={styles.money}>{format.money(row.amountOre)}</Text>}
		</>
	);
}

function ReportTable({ data, format, rows, title, details = false }: {
	data: ReportData;
	format: ReportFormat;
	rows: readonly TableRow[];
	title: string;
	details?: boolean;
}) {
	const { label } = format;
	// Cap each wrapping pass. The renderer otherwise revisits thousands of pending rows on each new page.
	const batchCount = Math.max(1, Math.ceil(rows.length / rowsPerBatch));
	return Array.from({ length: batchCount }, (_, batch) => (
		<SectionPage key={batch} data={data} format={format} title={title} table>
			<View style={[styles.cells, styles.tableHeader]} fixed>
				{details && <Text style={styles.date}>{label.date}</Text>}
				<Text style={styles.group}>{label.group}</Text>
				<Text style={styles.description}>{label.description}</Text>
				<Text style={styles.time}>{label.time}</Text>
				{data.showMoney && <Text style={styles.money}>{label.hourlyRate}</Text>}
				{data.showMoney && <Text style={styles.money}>{label.amount}</Text>}
			</View>
			{rows.length === 0 && <Text>{label.noTime}</Text>}
			{rows.slice(batch * rowsPerBatch, (batch + 1) * rowsPerBatch).map((row, index) => {
				const { description } = row;
				if (description.length > 400 || description.split('\n').length > 5) {
					return (
						<View key={index} style={styles.tableRow}>
							<View style={styles.cells} wrap={false} minPresenceAhead={30}>
								<TableCells row={row} data={data} format={format} details={details} />
							</View>
							<Text style={styles.longDescription}>{description}</Text>
						</View>
					);
				}
				return (
					<View key={index} style={[styles.cells, styles.tableRow]} wrap={false}>
						<TableCells row={row} data={data} format={format} details={details} description={description} />
					</View>
				);
			})}
		</SectionPage>
	));
}

function TimeReport({ data }: { data: ReportData }) {
	const format = reportFormat(data.language);
	const shares = data.projectShares.filter(({ seconds }) => seconds > 0);
	const months = Map.groupBy(data.days, ({ date }) => date.slice(0, 7));
	return (
		<Document title={format.label.title} author={data.ownerName} language={data.language}>
			<Overview data={data} format={format} shares={shares} />
			{shares.length > legendOnChartPage && (
				<SectionPage data={data} format={format} title={format.label.legendContinued}>
					<LegendRows data={data} format={format} shares={shares.slice(legendOnChartPage)} start={legendOnChartPage} />
				</SectionPage>
			)}
			{months.size > 0 && (
				<SectionPage data={data} format={format} title={format.label.dailyHours}>
					{[...months].map(([month, days]) => (
						<View key={month} style={styles.panel} wrap={false}>
							<Text style={styles.month}>{format.month(`${month}-01`)}</Text>
							<DailyBars days={days} format={format} />
						</View>
					))}
				</SectionPage>
			)}
			<ReportTable data={data} format={format} rows={data.summaries} title={format.label.descriptionSummaries} />
			{data.details && (
				<ReportTable data={data} format={format} rows={data.details} title={format.label.details} details />
			)}
		</Document>
	);
}

export const renderReport: ReportRenderer = (data) => renderToBuffer(<TimeReport data={data} />);
