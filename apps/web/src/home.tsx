import { useQuery } from '@tanstack/react-query';
import { healthPath, parseHealthResponse } from '@timekeeper/contracts';

export function Home() {
	const health = useQuery({
		queryKey: [healthPath],
		queryFn: async ({ signal }) => {
			const response = await fetch(healthPath, { signal });
			if (!response.ok) {
				throw new Error('Liveness request failed');
			}
			const payload: unknown = await response.json();
			return parseHealthResponse(payload);
		},
		retry: false,
		networkMode: 'always',
	});

	const checking = health.isPending || health.isFetching;
	const state = checking ? 'checking' : health.isError ? 'unavailable' : 'connected';
	const statusText = {
		checking: 'Checking connection…',
		unavailable: 'Could not connect to the API.',
		connected: 'API connected',
	}[state];

	return (
		<>
			<h1>Timekeeper</h1>
			<p className="intro">Check whether this workspace can reach the Timekeeper server.</p>
			<section className="connection-panel" aria-labelledby="connection-heading">
				<div>
					<h2 id="connection-heading">Server connection</h2>
					<p className="status" data-state={state} role="status">{statusText}</p>
				</div>
				<button type="button" disabled={checking} onClick={() => void health.refetch()}>
					Check connection
				</button>
			</section>
		</>
	);
}
