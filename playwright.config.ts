import { defineConfig } from '@playwright/test';

const host = '127.0.0.1';
const desktopPort = '4317';
const phonePort = '4318';
const catalogDesktopPort = '4319';
const catalogPhonePort = '4320';
const origin = (port: string) => `http://${host}:${port}`;
const catalogSpecs = '**/catalog.spec.ts';
const desktop = { viewport: { width: 1280, height: 800 } };
const phone = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };

export default defineConfig({
	testDir: './tests',
	use: { trace: 'retain-on-failure' },
	projects: [
		{ name: 'desktop', testIgnore: catalogSpecs, use: { ...desktop, baseURL: origin(desktopPort) } },
		{ name: 'phone', testIgnore: catalogSpecs, use: { ...phone, baseURL: origin(phonePort) } },
		{ name: 'catalog-desktop', testMatch: catalogSpecs, use: { ...desktop, baseURL: origin(catalogDesktopPort) } },
		{ name: 'catalog-phone', testMatch: catalogSpecs, use: { ...phone, baseURL: origin(catalogPhonePort) } },
	],
	webServer: [desktopPort, phonePort, catalogDesktopPort, catalogPhonePort].map((port) => ({
		command: 'node tests/start-server.ts',
		url: origin(port),
		env: { HOST: host, PORT: port, TIMEKEEPER_ORIGIN: origin(port) },
		reuseExistingServer: false,
		gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
	})),
});
