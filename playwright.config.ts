import { defineConfig } from '@playwright/test';

const host = '127.0.0.1';
const desktopPort = '4317';
const phonePort = '4318';
const origin = (port: string) => `http://${host}:${port}`;

export default defineConfig({
	testDir: './tests',
	use: { trace: 'retain-on-failure' },
	projects: [
		{ name: 'desktop', use: { baseURL: origin(desktopPort), viewport: { width: 1280, height: 800 } } },
		{ name: 'phone', use: { baseURL: origin(phonePort), viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
	],
	webServer: [desktopPort, phonePort].map((port) => ({
		command: 'node tests/start-server.ts',
		url: origin(port),
		env: { HOST: host, PORT: port, TIMEKEEPER_ORIGIN: origin(port) },
		reuseExistingServer: false,
		gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
	})),
});
