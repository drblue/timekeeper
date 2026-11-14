import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/auth/database.ts';
import { createBackup, restoreBackup } from '../src/backup/operations.ts';
import { readEncryptedArchive } from '../src/backup/archive.ts';
import { sha256File } from '../src/backup/files.ts';
import { inspectSqlite, snapshotSqlite } from '../src/backup/sqlite.ts';

const marker = '.timekeeper-backup-destination';
const oldFile = 'timekeeper-2026-10-01T000000Z-aaaaaaaaaaaaaaaa.tar.age';
const instant = new Date('2026-11-14T12:30:00Z');
const ageAvailable = spawnSync('age', ['--version'], { stdio: 'ignore' }).status === 0
	&& spawnSync('age-keygen', ['--help'], { stdio: 'ignore' }).status === 0;

describe('Operational backup and restore', () => {
	let workspace: string;
	let database: Awaited<ReturnType<typeof openDatabase>>;
	let source: string;
	let scratch: string;
	let destination: string;
	let accountId: string;
	let entryId: string;

	beforeAll(async () => {
		workspace = await mkdtemp(join(tmpdir(), 'timekeeper-backup-test-'));
		const data = join(workspace, 'data');
		scratch = join(workspace, 'scratch');
		destination = join(workspace, 'destination');
		await Promise.all([data, scratch, destination].map((directory) => mkdir(directory, { mode: 0o700 })));
		source = join(data, 'timekeeper.sqlite');
		execFileSync('npm', ['run', 'db:migrate'], {
			env: { ...process.env, TIMEKEEPER_DATABASE_URL: pathToFileURL(source).href }, stdio: 'pipe',
		});
		database = await openDatabase(pathToFileURL(source).href);
		await database.$queryRaw`PRAGMA wal_autocheckpoint = 0`;
		accountId = randomUUID();
		entryId = randomUUID();
		await database.account.create({ data: { id: accountId, email: 'backup@example.test', passwordHash: 'protected-example-hash' } });
		await database.session.create({
			data: { accountId, tokenHash: 'backup-example-session', expiresAt: new Date('2099-01-01T00:00:00Z') },
		});
		const projectId = randomUUID();
		await database.project.create({ data: { id: projectId, accountId, name: 'Durable project' } });
		await database.runningTimer.create({
			data: { accountId, id: randomUUID(), startAt: instant, description: 'Durable timer', projectId, billable: true, assignedRateOrePerHour: 8n },
		});
		await database.reportSettings.create({ data: {
			accountId, businessName: 'Backup branding', logoId: randomUUID(), logoWidth: 1, logoHeight: 1,
			logoBytes: await readFile('prototype/pdf/fixture-logo.png'),
		} });
		await database.entry.create({
			data: { id: entryId, accountId, kind: 'duration-only', description: 'Uncheckpointed work', localDate: '2026-11-14',
				durationSeconds: 3_600, projectId, billable: true, assignedRateOrePerHour: 9_007_199_254_740_993n,
				billableAmountOre: 9_007_199_254_740_993n, invoicedAt: instant, invoiceNumber: '00017', invoiceDate: '2026-11-14',
				allocations: { create: { localDate: '2026-11-14', seconds: 3_600, amountOre: 9_007_199_254_740_993n, calculationVersion: 4 } } },
		});
		await database.entryHistory.create({ data: { id: randomUUID(), entryId, action: 'created', at: instant, afterSnapshot: '{}' } });
		await database.operationReceipt.create({ data: {
			accountId, key: randomUUID(), requestHash: 'durable-hash', resultSnapshot: '{}', completedAt: instant,
		} });
		await database.reportJob.create({ data: {
			id: randomUUID(), accountId, status: 'ready', createdAt: instant, expiresAt: new Date('2099-01-01T00:00:00Z'),
		} });
		await database.bulkEntryPreview.create({ data: { id: randomUUID(), accountId, snapshot: '{}', expiresAt: instant } });
		const stageId = randomUUID();
		await database.clockifyImportStage.create({ data: { id: stageId, accountId, snapshot: '{}', expiresAt: instant } });
		await database.clockifyImportPreview.create({ data: { id: randomUUID(), accountId, stageId, expiresAt: instant, decisions: '{}', planHash: 'unused' } });

		const batchId = randomUUID();
		await database.clockifyImportBatch.create({ data: { id: batchId, accountId, committedAt: instant, snapshot: '{}', undoSnapshot: '{}' } });
		const fingerprint = 'a'.repeat(64);
		await database.clockifyImportIdentity.create({ data: {
			accountId, fingerprint, occurrence: 1, candidateKey: 'source', entryId, batchId, entryRevision: 1, sourceSnapshot: '{}',
		} });
		await database.clockifyImportAlias.create({ data: {
			accountId, fingerprint: 'b'.repeat(64), occurrence: 1, candidateKey: 'alias', targetFingerprint: fingerprint, targetOccurrence: 1,
			batchId, resolution: 'keep', sourceSnapshot: '{}',
		} });
		await database.clockifyReleasedIdentity.create({ data: {
			accountId, entryId, fingerprint: 'c'.repeat(64), occurrence: 1, candidateKey: 'released', batchId, entryRevision: 1, sourceSnapshot: '{}',
		} });
	});

	afterAll(async () => {
		await database?.$disconnect();
		await rm(workspace, { recursive: true, force: true });
	});

	it('uses a self-contained online snapshot to retain data still in the WAL', async () => {
		expect((await stat(source + '-wal')).size).toBeGreaterThan(32);
		const copy = join(scratch, 'wal-backup.sqlite');
		await snapshotSqlite(source, copy);
		expect(await readdir(scratch)).toEqual(['wal-backup.sqlite']);
		const manifest = await inspectSqlite(copy);
		expect(manifest).toMatchObject({
			schemaVersion: '0016_clockify_undo', counts: { Entry: '1', EntryHistory: '1', EntryDayAllocation: '1',
				ClockifyImportIdentity: '1', ClockifyImportAlias: '1', ClockifyReleasedIdentity: '1' },
			calculationVersions: [4], allocationTotals: { seconds: '3600', amountOre: '9007199254740993' },
		});
		await rm(copy);
	});

	it('fails closed before writes or retention if the destination marker or mount check fails', async () => {
		const options = { source, scratch, destination, destinationId: 'expected', recipients: join(workspace, 'missing-recipients'), now: instant };
		await expect(createBackup(options)).rejects.toThrow();
		await writeFile(join(destination, marker), 'wrong');
		await writeFile(join(destination, oldFile), 'old ciphertext', { mode: 0o600 });
		await writeFile(join(destination, oldFile + '.sha256'), 'old digest', { mode: 0o600 });
		await expect(createBackup({ ...options, requireSeparateFilesystem: false })).rejects.toThrow('marker');
		await writeFile(join(destination, marker), 'expected\n');
		await expect(createBackup(options)).rejects.toThrow('separate filesystem');
		expect((await readdir(destination)).sort()).toEqual([marker, oldFile, oldFile + '.sha256']);
		expect(await readdir(scratch)).toEqual([]);
	});

	it.skipIf(!ageAvailable)('encrypts, verifies, prunes complete old pairs, and restores only verified durable data', async () => {
		const identity = join(workspace, 'identity');
		const recipients = join(workspace, 'recipients');
		execFileSync('age-keygen', ['-o', identity], { stdio: 'ignore' });
		await chmod(identity, 0o600);
		await writeFile(recipients, execFileSync('age-keygen', ['-y', identity]));
		await writeFile(join(destination, marker), 'expected\n');
		const oldCiphertext = join(destination, oldFile);
		await writeFile(oldCiphertext, 'retention test', { mode: 0o600 });
		await writeFile(oldCiphertext + '.sha256', await sha256File(oldCiphertext) + '\n', { mode: 0o600 });
		const keep = 'timekeeper-2026-10-16T000000Z-bbbbbbbbbbbbbbbb.tar.age';
		await writeFile(join(destination, keep), 'retained', { mode: 0o600 });
		await writeFile(join(destination, keep + '.sha256'), await sha256File(join(destination, keep)) + '\n', { mode: 0o600 });
		const suspicious = 'timekeeper-2026-10-01T000000Z-cccccccccccccccc.tar.age';
		await symlink(oldCiphertext, join(destination, suspicious));
		await writeFile(join(destination, 'operator-note'), 'keep');

		const options = { source, scratch, destination, destinationId: 'expected', recipients, now: instant, requireSeparateFilesystem: false };
		const result = await createBackup(options);
		expect(result).toMatchObject({ status: 'ok', createdAt: instant.toISOString(), pruned: 1 });
		expect(JSON.parse(await readFile(join(destination, '.timekeeper-last-success.json'), 'utf8'))).toEqual(result);
		expect((await readdir(destination)).sort()).toEqual([
			marker, '.timekeeper-last-success.json', keep, keep + '.sha256', suspicious, result.file, result.file + '.sha256', 'operator-note',
		].sort());
		expect(await readdir(scratch)).toEqual([]);
		const encrypted = join(destination, result.file);
		expect((await readFile(encrypted)).subarray(0, 21).toString()).toBe('age-encryption.org/v1');

		const occupied = join(destination, '.timekeeper-backup.lock');
		await writeFile(occupied, '', { flag: 'wx', mode: 0o600 });
		await expect(createBackup({ ...options, now: new Date('2027-01-01T00:00:00Z') })).rejects.toThrow();
		expect(JSON.parse(await readFile(join(destination, '.timekeeper-last-success.json'), 'utf8'))).toEqual(result);
		expect(await readFile(join(destination, keep), 'utf8')).toBe('retained');
		expect(await readdir(scratch)).toEqual([]);
		await rm(occupied);

		const extracted = await mkdtemp(join(scratch, 'operator-verify-'));
		await readEncryptedArchive(encrypted, identity, extracted);
		const manifest = JSON.parse(await readFile(join(extracted, 'manifest.json'), 'utf8'));
		expect(manifest).toMatchObject({ format: 'timekeeper-backup', formatVersion: 1, counts: { Session: '1', ReportJob: '1' },
			persistentAssets: [{ kind: 'report-logo-png', sha256: await sha256File('prototype/pdf/fixture-logo.png') }],
			database: { sha256: await sha256File(join(extracted, 'timekeeper.sqlite')) } });
		await rm(extracted, { recursive: true });

		const restoreTarget = join(workspace, 'restore');
		await mkdir(restoreTarget, { mode: 0o700 });
		const restore = { destination, target: restoreTarget, file: result.file, identity, now: instant };
		const checksum = await readFile(encrypted + '.sha256', 'utf8');
		await writeFile(encrypted + '.sha256', '0'.repeat(64) + '\n');
		await expect(restoreBackup(restore)).rejects.toThrow('checksum');
		expect(await readdir(restoreTarget)).toEqual([]);
		await writeFile(encrypted + '.sha256', checksum);

		const malformed = join(destination, 'timekeeper-2026-11-14T000000Z-dddddddddddddddd.tar.age');
		const malformedSource = await mkdtemp(join(scratch, 'malformed-'));
		await Promise.all(['manifest.json', 'timekeeper.sqlite', 'extra'].map((name) => writeFile(join(malformedSource, name), '{}')));
		const tarBytes = execFileSync('tar', ['--format=ustar', '-cf', '-', '-C', malformedSource, 'manifest.json', 'timekeeper.sqlite', 'extra']);
		await writeFile(malformed, execFileSync('age', ['--encrypt', '--recipients-file', recipients], { input: tarBytes }), { mode: 0o600 });
		await writeFile(malformed + '.sha256', await sha256File(malformed) + '\n', { mode: 0o600 });
		await expect(restoreBackup({ ...restore, file: malformed.slice(destination.length + 1) })).rejects.toThrow('extra archive member');
		expect(await readdir(restoreTarget)).toEqual([]);
		await rm(malformedSource, { recursive: true });

		const wrongIdentity = join(workspace, 'wrong-identity');
		execFileSync('age-keygen', ['-o', wrongIdentity], { stdio: 'ignore' });
		await chmod(wrongIdentity, 0o600);
		await expect(restoreBackup({ ...restore, identity: wrongIdentity })).rejects.toThrow();
		expect(await readdir(restoreTarget)).toEqual([]);
		await expect(restoreBackup(restore)).resolves.toMatchObject({ status: 'ok', file: result.file, restoredAt: instant.toISOString() });
		await expect(restoreBackup(restore)).rejects.toThrow('empty');
		expect(await readdir(restoreTarget)).toEqual(['timekeeper.sqlite']);
		const restored = await openDatabase(pathToFileURL(join(restoreTarget, 'timekeeper.sqlite')).href);
		try {
			expect(await restored.entry.findUniqueOrThrow({ where: { id: entryId } })).toMatchObject({
				invoiceNumber: '00017', billableAmountOre: 9_007_199_254_740_993n, invoicedAt: instant,
			});
			expect(await restored.reportSettings.count()).toBe(1);
			expect(await restored.runningTimer.count()).toBe(1);
			expect(await restored.entryHistory.count()).toBe(1);
			expect(await restored.clockifyImportAlias.count()).toBe(1);
			expect(await restored.clockifyReleasedIdentity.count()).toBe(1);
			expect(await restored.operationReceipt.count()).toBe(1);
			expect(await restored.session.count()).toBe(0);
			expect(await restored.reportJob.count()).toBe(0);
			expect(await restored.bulkEntryPreview.count()).toBe(0);
			expect(await restored.clockifyImportStage.count()).toBe(0);
			expect(await restored.clockifyImportPreview.count()).toBe(0);
		} finally {
			await restored.$disconnect();
		}
		expect(await database.session.count()).toBe(1);
		expect(await database.reportJob.count()).toBe(1);
	});
});
