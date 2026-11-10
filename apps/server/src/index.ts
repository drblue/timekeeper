import { fileURLToPath } from 'node:url';
import { createApp } from './app.ts';

const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? '3000');

if (!Number.isInteger(port) || port < 1 || port > 65535) {
	throw new Error('PORT must be an integer between 1 and 65535');
}

const apiOnly = process.argv.includes('--api-only');
const webRoot = apiOnly ? undefined : fileURLToPath(new URL('../../web/dist/', import.meta.url));
const app = await createApp({ webRoot, logger: true });

try {
	await app.listen({ host, port });
} catch (error) {
	app.log.error(error);
	process.exitCode = 1;
	await app.close();
}

function close() {
	void app.close().catch((error: unknown) => {
		app.log.error(error);
		process.exitCode = 1;
	});
}

process.once('SIGINT', close);
process.once('SIGTERM', close);
