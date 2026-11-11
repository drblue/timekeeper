import { maxHourlyRateOre } from '@timekeeper/contracts';
import { ApiRequestError } from './api-error.ts';

export const maxStoredOre = BigInt(maxHourlyRateOre);

export function parseHourlyRateOre(rate: string | null, field: string): bigint | null {
	if (rate === null) {
		return null;
	}
	const value = BigInt(rate);
	if (value > maxStoredOre) {
		throw new ApiRequestError(422, 'INVALID_HOURLY_RATE', 'The hourly rate exceeds the supported maximum.', field);
	}
	return value;
}

export function calculateBillableAmountOre(durationSeconds: number, assignedRateOrePerHour: bigint): bigint {
	return (BigInt(durationSeconds) * assignedRateOrePerHour + 1_800n) / 3_600n;
}
