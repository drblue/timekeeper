import { defineConfig } from '@playwright/test';

const host = '127.0.0.1';
const port = '4317';
const baseURL = `http://${host}:${port}`;

export default defineConfig({
	testDir: './tests',
	use: { baseURL, trace: 'retain-on-failure' },
	projects: [
		{ name: 'desktop', use: { viewport: { width: 1280, height: 800 } } },
		{ name: 'phone', use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
	],
	webServer: {
		command: 'npm start',
		url: baseURL,
		env: { HOST: host, PORT: port },
		reuseExistingServer: false,
	},
});
