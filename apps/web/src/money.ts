import { maxHourlyRateOre } from '@timekeeper/contracts';

function oreParts(ore: string) {
	const digits = ore.padStart(3, '0');
	return { whole: digits.slice(0, -2), fraction: digits.slice(-2) };
}

export function rateInputValue(ore: string | null): string {
	if (ore === null) return '';
	const { whole, fraction } = oreParts(ore);
	return `${whole}.${fraction}`;
}

const wholeKronor = new Intl.NumberFormat('en', { maximumFractionDigits: 0 });

export function formatHourlyRate(ore: string): string {
	const { whole, fraction } = oreParts(ore);
	return `${wholeKronor.format(BigInt(whole))}.${fraction} SEK/hour`;
}

const swedishCurrency = new Intl.NumberFormat('sv-SE', {
	style: 'currency',
	currency: 'SEK',
	currencyDisplay: 'code',
});

export function formatSek(ore: string): string {
	const { whole, fraction } = oreParts(ore);
	return swedishCurrency.formatToParts(BigInt(whole))
		.map((part) => part.type === 'fraction' ? fraction : part.value)
		.join('');
}

export function parseHourlyRate(input: string): string | null {
	const text = input.trim();
	if (!text) return null;
	const [, whole, fraction = ''] = /^(\d{1,20})(?:[.,](\d{1,2}))?$/.exec(text) ?? [];
	if (whole === undefined) {
		throw new Error('Enter the hourly rate in SEK with up to two decimal places, or leave it blank.');
	}
	const ore = BigInt(whole + fraction.padEnd(2, '0'));
	if (ore > BigInt(maxHourlyRateOre)) {
		throw new Error(`Enter an hourly rate of ${rateInputValue(maxHourlyRateOre)} SEK or less.`);
	}
	return ore.toString();
}
