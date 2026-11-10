const windowMs = 15 * 60 * 1000;
const maximumBuckets = 10_000;

interface Bucket {
	count: number;
	expiresAt: number;
}

export function createAuthLimits() {
	const buckets = new Map<string, Bucket>();
	let sweepAt = 0;
	let activePasswordWork = 0;

	return {
		verificationRetryAfter(purpose: 'login' | 'password', email: string, clientAddress: string): number {
			const now = Date.now();
			if (now >= sweepAt) {
				for (const [key, bucket] of buckets) {
					if (bucket.expiresAt <= now) {
						buckets.delete(key);
					}
				}
				sweepAt = now + 30_000;
			}

			const counters = [
				{ key: `${purpose}:account:${email}`, limit: 5 },
				{ key: `${purpose}:address:${clientAddress}`, limit: 20 },
			].map(({ key, limit }) => {
				const existing = buckets.get(key);
				const bucket = existing && existing.expiresAt > now ? existing : { count: 0, expiresAt: now + windowMs };
				return { key, limit, bucket };
			});
			const retryAfter = Math.max(...counters.map(({ bucket, limit }) =>
				bucket.count >= limit ? Math.ceil((bucket.expiresAt - now) / 1000) : 0,
			));
			if (retryAfter > 0) {
				return retryAfter;
			}
			if (buckets.size + counters.filter(({ key }) => !buckets.has(key)).length > maximumBuckets) {
				return 30;
			}

			for (const { key, bucket } of counters) {
				bucket.count++;
				buckets.set(key, bucket);
			}
			return 0;
		},

		reservePasswordWork(): (() => void) | undefined {
			if (activePasswordWork >= 2) {
				return undefined;
			}
			activePasswordWork++;
			return () => { activePasswordWork--; };
		},
	};
}
