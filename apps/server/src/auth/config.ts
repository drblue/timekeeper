import { isIP } from 'node:net';

const loopbackHosts = new Set(['127.0.0.1', 'localhost', '::1']);

export function canonicalAddress(address: string): string {
	const version = isIP(address);
	if (version === 4) {
		return address;
	}
	if (version !== 6 || address.includes('%')) {
		return '';
	}

	const canonical = new URL(`http://[${address}]`).hostname.slice(1, -1);
	const [, first, second] = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(canonical) ?? [];
	if (first && second) {
		const high = Number.parseInt(first, 16);
		const low = Number.parseInt(second, 16);
		return [high >> 8, high & 255, low >> 8, low & 255].join('.');
	}
	return canonical;
}

export interface AuthConfig {
	origin: string;
	trustedProxyAddresses: ReadonlySet<string>;
}

export function readAuthConfig(
	environment: NodeJS.ProcessEnv,
	listenHost: string,
	developmentOrigin: string,
): AuthConfig {
	const configuredOrigin = environment.TIMEKEEPER_ORIGIN;
	if (environment.NODE_ENV === 'production' && !configuredOrigin) {
		throw new Error('Set TIMEKEEPER_ORIGIN to the public HTTPS origin in production.');
	}

	const value = configuredOrigin ?? developmentOrigin;
	let origin: URL;
	try {
		origin = new URL(value);
	} catch {
		throw new Error('TIMEKEEPER_ORIGIN must be an origin such as https://timekeeper.example.com.');
	}
	if (origin.origin !== value || !['http:', 'https:'].includes(origin.protocol)) {
		throw new Error('TIMEKEEPER_ORIGIN must contain only the scheme, host and optional port.');
	}

	const originHost = origin.hostname.replace(/^\[|\]$/g, '');
	const loopbackHttp = environment.NODE_ENV !== 'production' &&
		loopbackHosts.has(originHost) && loopbackHosts.has(listenHost);
	if (origin.protocol !== 'https:' && !loopbackHttp) {
		throw new Error('HTTPS is required except for a loopback development server and origin.');
	}

	const addresses = new Set<string>();
	if (environment.TIMEKEEPER_TRUSTED_PROXY_IPS) {
		for (const value of environment.TIMEKEEPER_TRUSTED_PROXY_IPS.split(',')) {
			const address = canonicalAddress(value.trim());
			if (!address || address === '0.0.0.0' || address === '::') {
				throw new Error('TIMEKEEPER_TRUSTED_PROXY_IPS must list literal proxy IP addresses.');
			}
			addresses.add(address);
		}
	}
	return { origin: origin.origin, trustedProxyAddresses: addresses };
}
