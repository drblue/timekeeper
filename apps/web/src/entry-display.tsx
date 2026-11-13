import { formatStockholmLocalTime } from '@timekeeper/contracts';
import { displayClock } from './entry-time';

export function formatDuration(seconds: number) {
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor(seconds / 60) % 60;
	const remainder = seconds % 60;
	return [hours ? `${hours} h` : '', minutes ? `${minutes} min` : '', remainder ? `${remainder} s` : '']
		.filter(Boolean)
		.join(' ') || '0 s';
}

export function stockholmTimeLabel(instant: string) {
	const { local, offset } = formatStockholmLocalTime(instant);
	return local.slice(0, 10) + ' ' + displayClock(local.slice(11)) + ' (UTC' + offset + ')';
}

export function StockholmTime({ instant }: { instant: string }) {
	return <time dateTime={instant}>{stockholmTimeLabel(instant)}</time>;
}
