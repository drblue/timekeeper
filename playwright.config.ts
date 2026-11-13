import { defineConfig } from '@playwright/test';

const host = '127.0.0.1';
const catalogSpecs = '**/catalog.spec.ts';
const entrySpecs = '**/entries.spec.ts';
const transitionSpecs = '**/timer-transitions.spec.ts';
const correctionSpecs = '**/entry-corrections.spec.ts';
const workListSpecs = '**/work-list.spec.ts';
const suites = [
	{ prefix: '', firstPort: 4317, filter: { testIgnore: [catalogSpecs, entrySpecs, transitionSpecs, correctionSpecs, workListSpecs] } },
	{ prefix: 'catalog-', firstPort: 4319, filter: { testMatch: catalogSpecs } },
	{ prefix: 'entries-', firstPort: 4321, filter: { testMatch: entrySpecs } },
	{ prefix: 'transitions-', firstPort: 4323, filter: { testMatch: transitionSpecs } },
	{ prefix: 'corrections-', firstPort: 4325, filter: { testMatch: correctionSpecs } },
	{ prefix: 'work-list-', firstPort: 4327, filter: { testMatch: workListSpecs } },
];
const viewports = [
	{ name: 'desktop', use: { viewport: { width: 1280, height: 800 } } },
	{ name: 'phone', use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
];
const projects = suites.flatMap(({ prefix, firstPort, filter }) => viewports.map((viewport, index) => ({
	name: prefix + viewport.name,
	use: { ...viewport.use, baseURL: `http://${host}:${firstPort + index}` },
	...filter,
})));

export default defineConfig({
	testDir: './tests',
	use: { trace: 'retain-on-failure' },
	projects,
	webServer: projects.map(({ use: { baseURL } }) => ({
		command: 'node tests/start-server.ts',
		url: baseURL,
		env: { HOST: host, PORT: new URL(baseURL).port, TIMEKEEPER_ORIGIN: baseURL },
		reuseExistingServer: false,
		gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
	})),
});
