import { fileURLToPath } from 'node:url';
import { createApp } from './app.ts';
import { readAuthConfig } from './auth/config.ts';
import { databaseUrl } from './auth/database-location.ts';
import { openDatabase } from './auth/database.ts';
import { createAuthStore } from './auth/store.ts';
import { createCatalogStore } from './catalog/store.ts';
import { createEntryStore } from './entries/store.ts';
import { createReportJobs, reportTimeoutMs } from './reports/jobs.ts';
import { createReportPreview } from './reports/routes.ts';
import { createReportSettings } from './reports/settings.ts';
import { createTimerStore } from './timer/store.ts';

const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? '3000');

if (!Number.isInteger(port) || port < 1 || port > 65535) {
	throw new Error('PORT must be an integer between 1 and 65535');
}

const apiOnly = process.argv.includes('--api-only');
const webRoot = apiOnly ? undefined : fileURLToPath(new URL('../../web/dist/', import.meta.url));
const localHost = host === '::1' ? '[::1]' : host;
const localOrigin = apiOnly ? 'http://127.0.0.1:5173' : new URL(`http://${localHost}:${port}`).origin;
const config = readAuthConfig(process.env, host, localOrigin);
const timeoutMs = reportTimeoutMs(process.env.TIMEKEEPER_REPORT_TIMEOUT_MS);
const localDatabaseUrl = databaseUrl();
const database = await openDatabase(localDatabaseUrl);
let reportJobs: Awaited<ReturnType<typeof createReportJobs>> | undefined;

let app: Awaited<ReturnType<typeof createApp>>;
try {
	const store = await createAuthStore(database);
	reportJobs = await createReportJobs(database, fileURLToPath(localDatabaseUrl) + '.report-artifacts', {
		timeoutMs,
		logError: () => app?.log.error('The report worker could not complete an operation.'),
	});
	app = await createApp({
		webRoot,
		logger: true,
		auth: { config, store },
		catalog: createCatalogStore(database),
		entries: createEntryStore(database),
		reportPreview: createReportPreview(database),
		reportJobs,
		reportSettings: createReportSettings(database),
		timer: createTimerStore(database),
	});
	app.addHook('onClose', async () => {
		await reportJobs?.close();
		await database.$disconnect();
	});
} catch {
	await reportJobs?.close();
	await database.$disconnect();
	throw new Error('Could not initialize the Timekeeper server. Check the web build and local installation.');
}

try {
	await app.listen({ host, port });
} catch {
	app.log.error('Could not start listening on the configured address.');
	process.exitCode = 1;
	await app.close();
}

function close() {
	void app.close().catch(() => {
		app.log.error('Could not close the Timekeeper server cleanly.');
		process.exitCode = 1;
	});
}

process.once('SIGINT', close);
process.once('SIGTERM', close);
