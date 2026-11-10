import type { ReportData } from './report-data.js';

const translations = {
	en: {
		title: 'Time report',
		summary: 'Report summary',
		client: 'Client',
		project: 'Project',
		all: 'All',
		billability: 'Billability',
		invoiceStatus: 'Invoice status',
		billable: 'Billable',
		nonBillable: 'Non-billable',
		invoiced: 'Invoiced',
		uninvoiced: 'Uninvoiced',
		totalHours: 'Total hours',
		billableAmount: 'Billable amount',
		projectShares: 'Time by project',
		projectLegend: 'Project legend',
		legendContinued: 'Project legend (continued)',
		noProject: 'No project',
		noTime: 'No recorded time in this period.',
		dailyHours: 'Daily hours',
		descriptionSummaries: 'Description summaries',
		details: 'Detailed entries',
		description: 'Description',
		date: 'Date',
		time: 'Time',
		hourlyRate: 'Rate / h',
		amount: 'Amount',
		group: 'Client / project',
		page: 'Page',
	},
	sv: {
		title: 'Tidrapport',
		summary: 'Rapportöversikt',
		client: 'Kund',
		project: 'Projekt',
		all: 'Alla',
		billability: 'Debiterbarhet',
		invoiceStatus: 'Fakturastatus',
		billable: 'Debiterbar',
		nonBillable: 'Ej debiterbar',
		invoiced: 'Fakturerat',
		uninvoiced: 'Ej fakturerat',
		totalHours: 'Totalt antal timmar',
		billableAmount: 'Debiterbart belopp',
		projectShares: 'Tid per projekt',
		projectLegend: 'Projektförteckning',
		legendContinued: 'Projektförteckning (fortsättning)',
		noProject: 'Inget projekt',
		noTime: 'Ingen registrerad tid under perioden.',
		dailyHours: 'Timmar per dag',
		descriptionSummaries: 'Sammanställning per beskrivning',
		details: 'Detaljerade tidposter',
		description: 'Beskrivning',
		date: 'Datum',
		time: 'Tid',
		hourlyRate: 'Timpris',
		amount: 'Belopp',
		group: 'Kund / projekt',
		page: 'Sida',
	},
};

export function reportFormat(language: ReportData['language']) {
	const locale = language === 'sv' ? 'sv-SE' : 'en-GB';
	const money = new Intl.NumberFormat(locale, {
		style: 'currency',
		currency: 'SEK',
		currencyDisplay: 'code',
	});
	const integer = new Intl.NumberFormat(locale);
	const decimal = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
	const month = new Intl.DateTimeFormat(locale, {
		month: 'long',
		year: 'numeric',
		timeZone: 'UTC',
	});

	return {
		label: translations[language],
		decimal: decimal.format,
		month: (iso: string) => month.format(new Date(`${iso}T00:00:00Z`)),
		money: (ore: bigint) => {
			const cents = (ore % 100n).toString().padStart(2, '0');
			return money.formatToParts(ore / 100n)
				.map((part) => part.type === 'fraction' ? cents : part.value)
				.join('');
		},
		share: (seconds: number, total: number) => {
			const ratio = seconds / total;
			const distanceFromEndpoint = Math.min(seconds, total - seconds) / total;
			const digits = distanceFromEndpoint > 0
				? Math.max(2, 1 - Math.floor(Math.log10(distanceFromEndpoint * 100)))
				: 2;
			return new Intl.NumberFormat(locale, {
				style: 'percent',
				maximumFractionDigits: digits,
			}).format(ratio);
		},
		duration: (seconds: number) => {
			const hours = integer.format(Math.floor(seconds / 3600));
			const minutes = Math.floor(seconds % 3600 / 60).toString().padStart(2, '0');
			const remainder = (seconds % 60).toString().padStart(2, '0');
			return `${hours}:${minutes}:${remainder}`;
		},
	};
}

export type ReportFormat = ReturnType<typeof reportFormat>;
