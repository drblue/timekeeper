import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function databaseUrl(environment: NodeJS.ProcessEnv = process.env): string {
	const value = environment.TIMEKEEPER_DATABASE_URL ?? pathToFileURL(resolve('timekeeper.sqlite')).href;
	try {
		const url = new URL(value);
		if (!value.startsWith('file:/') || url.hostname || url.search || url.hash) {
			throw new Error();
		}

		// Validate escapes and ensure Prisma and the runtime adapter use the same local file.
		return pathToFileURL(fileURLToPath(url)).href;
	} catch {
		throw new Error('TIMEKEEPER_DATABASE_URL must be an absolute local file URL.');
	}
}
