import type { BulkEntryPreviewResponse } from '@timekeeper/contracts';
import { formatDuration, StockholmTime } from './entry-display';
import { formatSek } from './money';

export function BulkSplitReview({ preview }: { preview: BulkEntryPreviewResponse }) {
	const sources = preview.entries.flatMap((entry) => entry.split ? [{ ...entry, portions: entry.split.portions }] : []);
	const portions = sources.flatMap((source) => source.portions);
	const markingCount = preview.count - sources.length + portions.filter((portion) => portion.willInvoice).length;
	return (
		<div className="bulk-split-review">
			{preview.canCommit && preview.invoiceTotals ? (
				<dl className="entry-invoice-values bulk-split-totals" aria-label="Work to be marked as invoiced">
					<div><dt>Entries to mark</dt><dd>{markingCount}</dd></div>
					<div><dt>Duration to mark</dt><dd>{formatDuration(preview.invoiceTotals.seconds)}</dd></div>
					<div><dt>Billable amount to mark</dt><dd>{formatSek(preview.invoiceTotals.amountOre)}</dd></div>
				</dl>
			) : null}
			<p>Times shown in Stockholm. Portions outside the selected dates remain uninvoiced.</p>
			{sources.map((source, index) => {
				const first = source.portions[0];
				const last = source.portions.at(-1);
				return (
					<details className="bulk-split-source" key={source.id} open={index === 0}>
						<summary>{source.description || 'Untitled time entry'}</summary>
						{first && last ? (
							<p className="field-hint">Original · <StockholmTime instant={first.startAt} /> to <StockholmTime instant={last.endAt} />
								{' · ' + formatDuration(source.seconds)}
								{source.amountOre === null ? null : ' · ' + formatSek(source.amountOre)}</p>
						) : null}
						<ul className="bulk-split-portions">
							{source.portions.map((portion) => (
								<li key={portion.startAt}>
									<strong>{portion.willInvoice ? 'Mark as invoiced' : 'Keep uninvoiced'}</strong>
									<p><StockholmTime instant={portion.startAt} /> to <StockholmTime instant={portion.endAt} /></p>
									<p>{formatDuration(portion.seconds)} · {formatSek(portion.amountOre)}</p>
								</li>
							))}
						</ul>
					</details>
				);
			})}
		</div>
	);
}
