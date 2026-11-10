import { readFileSync } from 'node:fs';
import type { ProjectShare, ReportData, ReportLine } from './report-data.js';

interface FixtureEntry extends ReportLine {
	readonly date: string;
	readonly clientId: string | null;
	readonly projectId: string | null;
}

const standard = {
	from: '2024-02-01',
	to: '2024-02-29',
	clientName: null,
	projectName: null,
	billability: 'all',
	invoiceStatus: 'all',
} satisfies ReportData['scope'];

function entry(date: string, seconds: number, {
	clientId = 'client-01', clientName = 'Sjövik Design', projectId = 'prototype', projectName = 'Prototype',
	description = 'Workshop', hourlyRateOre = 125_000n,
}: Partial<Omit<FixtureEntry, 'date' | 'seconds' | 'amountOre'>> = {}): FixtureEntry {
	return {
		date, seconds, clientId, clientName, projectId, projectName, description, hourlyRateOre,
		amountOre: hourlyRateOre === null ? 0n : (BigInt(seconds) * hourlyRateOre + 1800n) / 3600n,
	};
}

function calendarDays(from: string, to: string) {
	const current = new Date(`${from}T00:00:00Z`);
	const dates: string[] = [];
	for (let iso = from; iso <= to; iso = current.toISOString().slice(0, 10)) {
		dates.push(iso);
		current.setUTCDate(current.getUTCDate() + 1);
	}
	return dates;
}

function fixture(entries: readonly FixtureEntry[], {
	scope = standard, language = 'en', showMoney = false, appendix = false, logo,
}: Partial<Pick<ReportData, 'scope' | 'language' | 'showMoney' | 'logo'>> & { appendix?: boolean } = {}): ReportData {
	const daySeconds = new Map(calendarDays(scope.from, scope.to).map((date) => [date, 0]));
	const projectShares = new Map<string | null, ProjectShare>();
	const summaries = new Map<string, ReportLine>();
	let totalSeconds = 0;
	let totalAmountOre = 0n;
	for (const row of entries) {
		totalSeconds += row.seconds;
		totalAmountOre += row.amountOre;
		daySeconds.set(row.date, daySeconds.get(row.date)! + row.seconds);
		const previousProject = projectShares.get(row.projectId);
		projectShares.set(row.projectId, {
			projectId: row.projectId, projectName: row.projectName,
			clientName: row.projectId ? row.clientName : null,
			seconds: (previousProject?.seconds ?? 0) + row.seconds,
		});

		// This fixture produces pre-allocated report data without a dependency on the PDF renderer.
		const description = row.description.trim();
		const key = JSON.stringify([
			row.clientId, row.projectId, description, showMoney ? row.hourlyRateOre?.toString() : null,
		]);
		const previousSummary = summaries.get(key);
		summaries.set(key, {
			clientName: row.clientName, projectName: row.projectName, description, hourlyRateOre: row.hourlyRateOre,
			seconds: (previousSummary?.seconds ?? 0) + row.seconds,
			amountOre: (previousSummary?.amountOre ?? 0n) + row.amountOre,
		});
	}
	return {
		language, ownerName: 'Åsbacka Studio', scope, showMoney, logo, totalSeconds, totalAmountOre,
		days: Array.from(daySeconds, ([date, seconds]) => ({ date, seconds })),
		projectShares: [...projectShares.values()].sort((a, b) => b.seconds - a.seconds),
		summaries: [...summaries.values()],
		details: appendix ? [...entries].sort((a, b) => a.date.localeCompare(b.date)) : undefined,
	};
}

const sampleLogo = () => readFileSync(new URL('../fixture-logo.png', import.meta.url));
const noProject = { projectId: null, projectName: null };
const projectLabel = 'Förstudie av tillgänglighet och digitala arbetsflöden';

const fixtures = {
	empty: () => fixture([], { scope: { ...standard, to: '2024-02-07' } }),
	single: () => fixture([
		entry('2024-02-05', 10_800),
		entry('2024-02-06', 7200),
	], { scope: { ...standard, clientName: 'Sjövik Design', projectName: 'Prototype' } }),
	'no-project': () => fixture([
		entry('2024-02-02', 9045, noProject),
		entry('2024-02-04', 3600, { ...noProject, clientId: null, clientName: null }),
	], { language: 'sv' }),
	'dense-sv': () => fixture([
		entry('2024-02-01', 999_999, { projectId: 'main', projectName: projectLabel, clientName: 'Älvängen Form' }),
		...Array.from({ length: 50 }, (_, index) => {
			const id = String(index + 1).padStart(2, '0');
			const sharedName = index === 0 || index === 10;
			return entry('2024-02-10', 3500 - index * 50, {
				projectId: id,
				projectName: sharedName ? 'Gemensamt namn' : `Projekt ${id}`,
				clientId: `client-${id}`,
				clientName: sharedName && index === 10 ? 'Ögården' : 'Sjövik Design',
			});
		}),
		entry('2024-02-11', 90, noProject),
		entry('2024-02-29', 1, { projectId: 'tiny', projectName: 'Minsta andel', hourlyRateOre: 1800n }),
	], { language: 'sv', logo: sampleLogo() }),
	'detailed-en': () => fixture([
		entry('2024-02-03', 3601, { description: '  Återkoppling för Sjövik  ', hourlyRateOre: 80_001n }),
		entry('2024-02-04', 1801, { description: 'Återkoppling för Sjövik', hourlyRateOre: 80_001n }),
		entry('2024-02-05', 901, { description: 'Återkoppling för Sjövik', hourlyRateOre: 90_001n }),
		entry('2024-02-06', 610, { description: 'återkoppling för Sjövik', hourlyRateOre: 80_001n }),
		entry('2024-02-07', 602, { projectId: 'second', description: 'Återkoppling för Sjövik', hourlyRateOre: 80_001n }),
		entry('2024-02-08', 630, { ...noProject, description: 'Explicit zero rate', hourlyRateOre: 0n }),
		entry('2024-02-09', 1501, { ...noProject, description: 'Non-billable work', hourlyRateOre: null }),
		entry('2024-02-10', 1, { description: 'Half-öre rounds up', hourlyRateOre: 1800n }),
		entry('2024-02-10', 1, { description: 'Just below half an öre', hourlyRateOre: 1799n }),
		entry('2024-02-11', 1234, {
			description: [
				'Long description start. Förberedelser, återkoppling och genomgång av gränssnittet.',
				'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.repeat(12),
				...Array.from({ length: 68 }, (_, index) =>
					`Step ${String(index + 1).padStart(2, '0')}. Review the exported report with Åsa, Björn and Östen.`),
				'Long description end. Slutkommentar.',
			].join('\n'),
			hourlyRateOre: 92_501n,
		}),
	], { showMoney: true, appendix: true, logo: sampleLogo() }),
	'year-large-sv': () => {
		const scope = { ...standard, from: '2024-01-01', to: '2024-12-31' };
		const activeDates = calendarDays(scope.from, scope.to).filter((_, index) => index % 7 < 5);
		return fixture(Array.from({ length: 3200 }, (_, index) => {
			const project = index % 8 + 1;
			const date = activeDates[Math.floor(index * activeDates.length / 3200)]!;
			return entry(date, 850 + index % 2400, {
				projectId: String(project),
				projectName: `Årsprojekt ${project}`,
				description: ['Kvalitetsgranskning', 'Planeringsmöte', 'Utveckling', 'Överlämning'][Math.floor(index / 8) % 4],
				hourlyRateOre: [92_501n, 125_000n, 80_001n][Math.floor(index / 32) % 3],
			});
		}), { scope, language: 'sv', showMoney: true, appendix: true });
	},
};

export type FixtureName = keyof typeof fixtures;
export const fixtureNames = Object.keys(fixtures) as FixtureName[];

export function createFixture(name: string) {
	if (!Object.hasOwn(fixtures, name)) {
		throw new Error(`Unknown fixture: ${name}. Choose ${fixtureNames.join(', ')}.`);
	}
	return fixtures[name as FixtureName]();
}
