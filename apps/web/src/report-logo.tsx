import { useState } from 'react';

export function ReportLogo({ url, alt, refresh, message = 'Could not load the saved logo.', retryLabel = 'Refresh logo' }: {
	url: string;
	alt: string;
	refresh: () => Promise<unknown>;
	message?: string;
	retryLabel?: string;
}) {
	const [failed, setFailed] = useState(false);
	const [pending, setPending] = useState(false);

	async function retry() {
		setPending(true);
		try {
			await refresh();
			setFailed(false);
		} finally {
			setPending(false);
		}
	}

	return (
		<div className="report-logo-display" aria-busy={pending}>
			{failed ? (
				<>
					<p className="field-hint" role="status">{message}</p>
					<button type="button" disabled={pending} onClick={() => void retry()}>{retryLabel}</button>
				</>
			) : <img className="report-logo" src={url} alt={alt} onError={() => setFailed(true)} />}
		</div>
	);
}
