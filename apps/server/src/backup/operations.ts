import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, link, lstat, mkdtemp, open, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { readEncryptedArchive, writeEncryptedArchive } from './archive.ts';
import { backupFilenamePattern, databaseFilename, manifestFilename, readSmallFile, requirePrivateDirectory, sha256File, sha256Pattern, syncFile } from './files.ts';
import { clearTransientRestoreData, inspectSqlite, snapshotSqlite } from './sqlite.ts';

const markerFilename = '.timekeeper-backup-destination';
const successFilename = '.timekeeper-last-success.json';
const lockFilename = '.timekeeper-backup.lock';
const dayMs = 24 * 60 * 60 * 1_000;
const applicationVersion = JSON.parse(await readSmallFile(fileURLToPath(new URL('../../../../package.json', import.meta.url)), 16_384)).version as string;
type Progress = (stage: string) => void;

export interface BackupOptions {
	source: string;
	destination: string;
	destinationId: string;
	recipients: string;
	scratch: string;
	requireSeparateFilesystem?: boolean;
	signal?: AbortSignal;
	now?: Date;
}

export interface RestoreOptions {
	file: string;
	destination: string;
	identity: string;
	target: string;
	signal?: AbortSignal;
	now?: Date;
}

async function destinationGuard(path: string, id: string) {
	if (!/^[A-Za-z0-9_.-]{1,128}$/.test(id)) throw new Error('Invalid backup destination identifier');
	const directory = await requirePrivateDirectory(path);
	const { dev, ino } = await stat(directory);
	const marker = (await readSmallFile(join(directory, markerFilename), 256)).trim();
	if (marker !== id) throw new Error('Backup destination marker does not match');
	return { directory, dev, ino };
}

async function assertSameDestination(path: string, id: string, expected: Awaited<ReturnType<typeof destinationGuard>>) {
	const current = await destinationGuard(path, id);
	if (current.dev !== expected.dev || current.ino !== expected.ino || current.directory !== expected.directory) {
		throw new Error('Backup destination changed during backup');
	}
}

function safeBackupName(name: string) {
	const match = backupFilenamePattern.exec(name);
	const day = match?.[1];
	const instant = day ? Date.parse(day + 'T00:00:00Z') : NaN;
	return Number.isFinite(instant) && new Date(instant).toISOString().slice(0, 10) === day;
}

async function checkedCiphertext(directory: string, name: string, signal?: AbortSignal) {
	if (!safeBackupName(name)) throw new Error('Invalid backup filename');
	const file = join(directory, name);
	const digest = (await readSmallFile(file + '.sha256', 128, true)).trim();
	const info = await lstat(file);
	if (!info.isFile() || (info.mode & 0o077) || !sha256Pattern.test(digest) || await sha256File(file, signal) !== digest) {
		throw new Error('Encrypted backup checksum mismatch');
	}
	return file;
}

async function pruneBackups(directory: string, instant: Date, keep: string) {
	const cutoff = new Date(Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), instant.getUTCDate()) - 29 * dayMs)
		.toISOString().slice(0, 10);
	let pruned = 0;
	for (const file of await readdir(directory, { withFileTypes: true })) {
		const name = file.name;
		if (!file.isFile() || name === keep || !safeBackupName(name) || name.slice(11, 21) >= cutoff) continue;
		const archive = join(directory, name);
		const checksum = archive + '.sha256';
		const info = await lstat(checksum).catch((error: NodeJS.ErrnoException) => {
			if (error.code === 'ENOENT') return null;
			throw error;
		});
		if (!info?.isFile()) continue;
		await rm(archive);
		await rm(checksum);
		pruned += 1;
	}
	return pruned;
}

export async function createBackup(options: BackupOptions, progress: Progress = () => {}) {
	progress('destination');
	const destination = await destinationGuard(options.destination, options.destinationId);
	const source = await lstat(options.source);
	const scratchRoot = await requirePrivateDirectory(options.scratch);
	const sourceDirectory = await requirePrivateDirectory(join(options.source, '..'));
	if (!source.isFile() || (source.mode & 0o077) || sourceDirectory === destination.directory
		|| (options.requireSeparateFilesystem !== false && source.dev === destination.dev) || destination.directory === scratchRoot) {
		throw new Error('Backup destination must be on a separate filesystem');
	}
	const recipientLines = (await readSmallFile(options.recipients, 16_384)).split(/\r?\n/)
		.map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
	if (!recipientLines.length || recipientLines.some((line) => !/^age1[0-9a-z]+$/.test(line))) {
		throw new Error('Use a native age public recipients file');
	}
	const scratch = await mkdtemp(join(scratchRoot, '.timekeeper-backup-'));
	const instant = options.now ?? new Date();
	const basename = `timekeeper-${instant.toISOString().slice(0, 19).replaceAll(':', '')}Z-${randomBytes(8).toString('hex')}.tar.age`;
	let temporaryDirectory: string | undefined;
	let lock: Awaited<ReturnType<typeof open>> | undefined;
	let archivePublished = false;
	let checksumPublished = false;
	let verified = false;
	const archive = join(destination.directory, basename);
	try {
		progress('snapshot');
		const database = join(scratch, databaseFilename);
		await snapshotSqlite(options.source, database, options.signal);
		await chmod(database, 0o600);
		const manifest = {
			format: 'timekeeper-backup', formatVersion: 1, applicationVersion, createdAt: instant.toISOString(),
			database: { file: databaseFilename, bytes: (await stat(database)).size, sha256: await sha256File(database, options.signal) },
			...await inspectSqlite(database),
		};
		await writeFile(join(scratch, manifestFilename), JSON.stringify(manifest) + '\n', { flag: 'wx', mode: 0o600 });
		const recipients = join(scratch, 'recipients');
		await writeFile(recipients, recipientLines.join('\n') + '\n', { flag: 'wx', mode: 0o600 });
		progress('encryption');
		const encrypted = join(scratch, basename);
		await writeEncryptedArchive(scratch, recipients, encrypted, options.signal);
		const digest = await sha256File(encrypted, options.signal);

		progress('external copy');
		await assertSameDestination(options.destination, options.destinationId, destination);
		options.signal?.throwIfAborted();
		lock = await open(join(destination.directory, lockFilename), 'wx', 0o600);
		temporaryDirectory = await mkdtemp(join(destination.directory, '.timekeeper-incoming-'));
		const incoming = join(temporaryDirectory, basename);
		const input = await open(encrypted, constants.O_RDONLY | constants.O_NOFOLLOW);
		const output = await open(incoming, 'wx', 0o600);
		try {
			await pipeline(input.createReadStream(), output.createWriteStream(), { signal: options.signal });
		} finally {
			await Promise.allSettled([input.close(), output.close()]);
		}
		await syncFile(incoming);
		if (await sha256File(incoming, options.signal) !== digest) throw new Error('External ciphertext checksum mismatch');
		await writeFile(incoming + '.sha256', digest + '\n', { flag: 'wx', mode: 0o600 });
		await syncFile(incoming + '.sha256');
		await assertSameDestination(options.destination, options.destinationId, destination);
		await link(incoming, archive);
		archivePublished = true;
		await link(incoming + '.sha256', archive + '.sha256');
		checksumPublished = true;
		await checkedCiphertext(destination.directory, basename, options.signal);
		await syncFile(destination.directory);
		verified = true;

		progress('retention');
		options.signal?.throwIfAborted();
		await assertSameDestination(options.destination, options.destinationId, destination);
		const pruned = await pruneBackups(destination.directory, instant, basename);
		const result = { status: 'ok', file: basename, createdAt: instant.toISOString(), pruned };
		const success = join(temporaryDirectory, successFilename);
		await writeFile(success, JSON.stringify(result) + '\n', { flag: 'wx', mode: 0o600 });
		await syncFile(success);
		await rename(success, join(destination.directory, successFilename));
		await syncFile(destination.directory);
		return result;
	} finally {
		if (!verified && (archivePublished || checksumPublished)) {
			await assertSameDestination(options.destination, options.destinationId, destination).then(async () => {
				if (checksumPublished) await rm(archive + '.sha256', { force: true });
				if (archivePublished) await rm(archive, { force: true });
			}).catch(() => {});
		}
		try {
			if (temporaryDirectory) await assertSameDestination(options.destination, options.destinationId, destination)
				.then(() => rm(temporaryDirectory!, { recursive: true, force: true }));
		} finally {
			try {
				if (lock) {
					await lock.close();
					await assertSameDestination(options.destination, options.destinationId, destination)
						.then(() => rm(join(destination.directory, lockFilename), { force: true }));
				}
			} finally {
				await rm(scratch, { recursive: true, force: true });
			}
		}
	}
}

export async function restoreBackup(options: RestoreOptions, progress: Progress = () => {}) {
	progress('restore target');
	const target = await requirePrivateDirectory(options.target);
	const destination = await requirePrivateDirectory(options.destination);
	if (target === destination || (await readdir(target)).length) throw new Error('Use a new empty restore data directory');
	await readSmallFile(options.identity, 16_384, true);
	progress('encrypted checksum');
	const encrypted = await checkedCiphertext(destination, options.file, options.signal);
	const scratch = await mkdtemp(join(target, '.timekeeper-restore-'));
	try {
		progress('decryption');
		await readEncryptedArchive(encrypted, options.identity, scratch, options.signal);
		progress('manifest and database verification');
		const manifest = JSON.parse(await readSmallFile(join(scratch, manifestFilename), 256 * 1024, true));
		const database = join(scratch, databaseFilename);
		const { format, formatVersion, applicationVersion: archivedVersion, createdAt, database: file, ...facts } = manifest;
		if (format !== 'timekeeper-backup' || formatVersion !== 1 || typeof archivedVersion !== 'string'
			|| typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt))
			|| file?.file !== databaseFilename || file.bytes !== (await stat(database)).size
			|| file.sha256 !== await sha256File(database, options.signal)) {
			throw new Error('Backup manifest does not match the verified database');
		}
		if (!isDeepStrictEqual(facts, await inspectSqlite(database))) throw new Error('Backup database verification failed');

		progress('restore publication');
		options.signal?.throwIfAborted();
		clearTransientRestoreData(database);
		await inspectSqlite(database);
		await chmod(database, 0o600);
		await syncFile(database);
		if ((await readdir(target)).some((name) => join(target, name) !== scratch)) throw new Error('Restore data directory is no longer empty');
		await link(database, join(target, databaseFilename));
		await syncFile(target);
		return { status: 'ok', file: options.file, restoredAt: (options.now ?? new Date()).toISOString() };
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}
