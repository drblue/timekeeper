import { fileURLToPath } from 'node:url';
import { databaseUrl } from '../auth/database-location.ts';
import { createBackup, restoreBackup } from './operations.ts';

const [action, file, ...extra] = process.argv.slice(2);
const environment = process.env;
let stage = 'configuration';
const shutdown = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => shutdown.abort());
const progress = (value: string) => { stage = value; };

async function run() {
	process.umask(0o077);
	if (extra.length) throw new Error('Unexpected command arguments');
	if (action === 'backup' && file === undefined) {
		return createBackup({
			source: fileURLToPath(databaseUrl()),
			destination: environment.TIMEKEEPER_BACKUP_DIR ?? '/backup',
			destinationId: environment.TIMEKEEPER_BACKUP_DESTINATION_ID ?? '',
			recipients: environment.TIMEKEEPER_BACKUP_RECIPIENTS ?? '/keys/recipients',
			scratch: environment.TIMEKEEPER_BACKUP_SCRATCH_DIR ?? '/scratch',
			requireSeparateFilesystem: environment.TIMEKEEPER_BACKUP_STAGING !== '1',
			signal: shutdown.signal,
		}, progress);
	}
	if (action === 'restore' && file) {
		return restoreBackup({
			file,
			destination: environment.TIMEKEEPER_BACKUP_DIR ?? '/backup',
			identity: environment.TIMEKEEPER_BACKUP_IDENTITY ?? '/keys/identity',
			target: environment.TIMEKEEPER_RESTORE_DIR ?? '/var/lib/timekeeper',
			signal: shutdown.signal,
		}, progress);
	}
	throw new Error('Unknown backup operation');
}

try {
	console.log(JSON.stringify(await run()));
} catch {
	console.error(`Timekeeper ${action === 'restore' ? 'restore' : 'backup'} failed: ${stage}.`);
	process.exitCode = 1;
}
