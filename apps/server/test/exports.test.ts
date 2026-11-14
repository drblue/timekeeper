import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { entriesCsvExportPath, parseWorkListResponse, portableExportPath, workListPath } from '@timekeeper/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { openDatabase } from '../src/auth/database.ts';
import { createAuthStore, randomToken } from '../src/auth/store.ts';
import { createEntryStore, writeEntry } from '../src/entries/store.ts';
import { timedInterval } from '../src/entries/timed-entry.ts';
import { createExportSpool } from '../src/exports/spool.ts';
import { createClockifyImportStore } from '../src/imports/clockify-store.ts';

const origin = 'https://timekeeper.example.test';
const date = new Date('2026-11-14T00:00:00Z');
const canary = 'export-private-canary';
const exact = 9_007_199_254_740_993n;

function spreadsheetRows(text: string) {
	const rows: string[][] = [];
	let fields: string[] = [];
	let value = '';
	let inQuotes = false;
	for (let index = 1; index < text.length; index += 1) {
		const current = text[index]!;
		if (current === '"') {
			if (inQuotes && text[index + 1] === '"') {
				value += '"';
				index += 1;
			} else inQuotes = !inQuotes;
		} else if (!inQuotes && (current === ';' || current === '\r')) {
			fields.push(value);
			value = '';
			if (current === '\r') {
				expect(text[++index]).toBe('\n');
				rows.push(fields);
				fields = [];
			}
		} else value += current;
	}
	return rows;
}

describe('Owner data exports', () => {
	let directory: string;
	let database: Awaited<ReturnType<typeof openDatabase>>;
	let app: Awaited<ReturnType<typeof createApp>>;
	let auth: { cookies: Record<string, string> };
	let accountId: string;
	let clientId: string;
	let projectId: string;
	let splitChildId: string;
	let splitRootId: string;
	let foreignId: string;
	let releasedId: string;
	let correctedId: string;

	beforeAll(async () => {
		directory = await mkdtemp(join(tmpdir(), 'timekeeper-export-test-'));
		const filename = pathToFileURL(join(directory, 'test.sqlite')).href;
		execFileSync('npm', ['run', 'db:migrate'], {
			env: { ...process.env, TIMEKEEPER_DATABASE_URL: filename }, stdio: 'pipe',
		});
		database = await openDatabase(filename);
		accountId = randomUUID();
		await database.account.create({ data: { id: accountId, email: canary + '@example.test', passwordHash: canary } });
		const token = randomToken();
		await database.session.create({
			data: { accountId, tokenHash: createHash('sha256').update(token).digest('hex'), expiresAt: new Date(Date.now() + 60_000) },
		});
		auth = { cookies: { '__Host-timekeeper-session': token } };
		app = await createApp({
			auth: { config: { origin, trustedProxyAddresses: new Set() }, store: await createAuthStore(database) },
			entries: createEntryStore(database, () => date), exportDatabase: database,
		});

		await database.$executeRaw`PRAGMA ignore_check_constraints = ON`;
		try {
			foreignId = randomUUID();
			await database.account.create({ data: { id: foreignId, ownerSlot: 2, email: 'foreign@example.test', passwordHash: 'unused' } });
		} finally {
			await database.$executeRaw`PRAGMA ignore_check_constraints = OFF`;
		}

		const imports = createClockifyImportStore(database, () => date);
		const header = 'Project,Client,Description,Task,User,Group,Email,Tags,Start Date,Start Time,End Date,End Time,Duration (h),Duration (decimal),Date of creation\n';
		async function stage(description: string, day: string) {
			return imports.stage(accountId, Buffer.from(header +
				`,,${description},,Example user,,source@example.test,,${day},08:00:00,${day},09:00:00,01:00:00,1,01/10/2026\n`), {});
		}
		const original = await stage('Imported root', '01/10/2026');
		const originalReview = await imports.review(accountId, { stageId: original.stageId, defaults: { billing: { mode: 'billable', rateOrePerHour: '0' } }, rows: [] });
		const originalCommit = await imports.commit(accountId, randomUUID(), originalReview.previewToken!);
		const root = await database.clockifyImportIdentity.findFirstOrThrow({ where: { batchId: originalCommit.batchId! } });
		correctedId = root.entryId;
		const correction = await stage('Changed source', '01/10/2026');
		const correctionReview = await imports.review(accountId, { stageId: correction.stageId,
			rows: [{ line: 2, correction: { mode: 'update', entryId: root.entryId, revision: root.entryRevision } }],
		});
		const correctionCommit = await imports.commit(accountId, randomUUID(), correctionReview.previewToken!);
		const correctionUndo = await imports.previewUndo(accountId, correctionCommit.batchId!);
		await imports.undo(accountId, correctionCommit.batchId!, correctionUndo.previewHash!, randomUUID());
		const kept = await stage('Kept source', '01/10/2026');
		const keptReview = await imports.review(accountId, { stageId: kept.stageId,
			rows: [{ line: 2, correction: { mode: 'keep', entryId: root.entryId, revision: 3 } }],
		});
		await imports.commit(accountId, randomUUID(), keptReview.previewToken!);
		const released = await stage('Released root', '02/10/2026');
		const releasedReview = await imports.review(accountId, { stageId: released.stageId, defaults: { billing: { mode: 'non-billable' } }, rows: [] });
		const releasedCommit = await imports.commit(accountId, randomUUID(), releasedReview.previewToken!);
		const releaseUndo = await imports.previewUndo(accountId, releasedCommit.batchId!);
		await imports.undo(accountId, releasedCommit.batchId!, releaseUndo.previewHash!, randomUUID());
		releasedId = (await database.clockifyReleasedIdentity.findFirstOrThrow()).entryId;

		clientId = randomUUID();
		projectId = randomUUID();
		await database.client.create({ data: { id: clientId, accountId, name: '\u200b=client', defaultRateOrePerHour: exact, archivedAt: date } });
		await database.project.create({ data: { id: projectId, accountId, clientId, name: "'Literal; project", rateOverrideOrePerHour: null } });
		await database.reportSettings.create({ data: {
			accountId, businessName: 'Export business', logoId: randomUUID(), logoWidth: 1, logoHeight: 1,
			logoBytes: await readFile('prototype/pdf/fixture-logo.png'),
		} });
		await database.runningTimer.create({ data: { accountId, id: randomUUID(), startAt: date, description: 'Running, not CSV', projectId,
			billable: true, assignedRateOrePerHour: exact } });
		const start = new Date('2026-11-11T22:30:00Z');
		const end = new Date('2026-11-11T23:30:00Z');
		const work = { description: ' \t=SUM(1;2)\r\n"quoted"\u0001', projectId, directClientId: null, billable: true, assignedRateOrePerHour: 1n };
		const split = await database.$transaction((transaction) => writeEntry(
			transaction, accountId, 'timed', timedInterval(start, end), work, date, { operationKey: canary },
		));
		splitRootId = split.id;
		const splitChild = await database.$transaction((transaction) => writeEntry(
			transaction, accountId, 'timed', timedInterval(start, end), work, date,
		));
		splitChildId = splitChild.id;
		await database.entry.update({ where: { id: split.id }, data: { supersededAt: date } });
		await database.entry.update({ where: { id: splitChild.id }, data: {
			splitFromEntryId: split.id, invoicedAt: date, invoiceNumber: '00017', invoiceDate: '2026-11-13', invoiceReference: '\t+reference',
		} });
		await database.entryDayAllocation.updateMany({ where: { entryId: splitChild.id }, data: { calculationVersion: 4 } });
		await database.$transaction((transaction) => writeEntry(
			transaction, accountId, 'timed', timedInterval(start, end), { ...work, description: '', assignedRateOrePerHour: null },
			date, { allowIncomplete: true },
		));
		await database.$transaction((transaction) => writeEntry(
			transaction, foreignId, 'timed', timedInterval(start, end), { ...work, projectId: null, description: canary },
			date,
		));
		await database.operationReceipt.create({ data: {
			accountId, key: canary, requestHash: canary, resultSnapshot: JSON.stringify({ tokenHash: canary }), completedAt: date,
		} });

		const history = await database.entryHistory.findFirstOrThrow({ where: { entryId: split.id } });
		const legacy = JSON.parse(history.afterSnapshot);
		legacy.sessionToken = canary;
		legacy.entry.passwordHash = canary;
		await database.entryHistory.update({ where: { id: history.id }, data: { afterSnapshot: JSON.stringify(legacy) } });

		const oldBatch = await database.clockifyImportBatch.findUniqueOrThrow({ where: { id: originalCommit.batchId! } });
		const snapshot = JSON.parse(oldBatch.snapshot);
		delete snapshot.review.counts.duplicateOmitted;
		delete snapshot.review.counts.keptExisting;
		delete snapshot.review.counts.updatedExisting;
		delete snapshot.review.duplicateGroups;
		delete snapshot.review.rows[0].correction;
		snapshot.decisions.stageId = canary;
		snapshot.decisions.defaults.billing.tokenHash = canary;
		snapshot.review.rows[0].approved.sessionToken = canary;
		await database.clockifyImportBatch.update({ where: { id: oldBatch.id }, data: { snapshot: JSON.stringify(snapshot) } });

		const undone = await database.clockifyImportBatch.findUniqueOrThrow({ where: { id: correctionCommit.batchId! } });
		const undoSnapshot = JSON.parse(undone.undoSnapshot!);
		undoSnapshot.operationKey = canary;
		undoSnapshot.aliases[0].sessionToken = canary;
		const aliasSource = JSON.parse(undoSnapshot.aliases[0].sourceSnapshot);
		aliasSource.source.tokenHash = canary;
		undoSnapshot.aliases[0].sourceSnapshot = JSON.stringify(aliasSource);
		await database.clockifyImportBatch.update({ where: { id: undone.id }, data: { undoSnapshot: JSON.stringify(undoSnapshot) } });
	}, 15_000);

	afterAll(async () => {
		await app?.close();
		await database?.$disconnect();
		await rm(directory, { recursive: true, force: true });
	});

	it('round-trips every section, checks exact integers, links, assets and checksums, and omits secrets', async () => {
		expect((await app.inject({ url: portableExportPath })).statusCode).toBe(401);
		const response = await app.inject({ ...auth, url: portableExportPath });
		expect(response.statusCode, response.body.slice(0, 160)).toBe(200);
		expect(response.headers).toMatchObject({ 'content-type': 'application/gzip', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
		expect(response.headers['content-disposition']).toMatch(/attachment; filename="timekeeper-portable-\d{4}-\d{2}-\d{2}\.ndjson\.gz"/);
		const decoded = gunzipSync(response.rawPayload).toString('utf8');
		expect(decoded).not.toContain(canary);
		expect(decoded).not.toContain(foreignId);
		expect(decoded).not.toContain('operationKey');
		expect(decoded).not.toContain('stageId');
		const lines = decoded.trimEnd().split('\n');
		const manifest = JSON.parse(lines.pop()!);
		expect(manifest).toMatchObject({ section: 'manifest', data: {
			format: 'timekeeper-portable', formatVersion: 1, schemaVersion: '0016_clockify_undo', currency: 'SEK',
			timezone: 'Europe/Stockholm', calculationVersion: 1, calculationVersions: [1, 4], algorithm: 'sha256',
		} });
		const grouped = new Map<string, Record<string, any>[]>();
		const exactLines = new Map<string, string[]>();
		for (const line of lines) {
			const { section, data } = JSON.parse(line);
			grouped.set(section, [...grouped.get(section) ?? [], data]);
			exactLines.set(section, [...exactLines.get(section) ?? [], line + '\n']);
		}
		expect(Object.keys(manifest.data.sections)).toEqual([
			'account', 'clients', 'projects', 'entries', 'entryDayAllocations', 'entryHistory', 'runningTimer', 'reportSettings',
			'clockifyImportBatches', 'clockifyImportIdentities', 'clockifyImportAliases', 'clockifyReleasedIdentities',
		]);
		for (const [section, manifestEntry] of Object.entries(manifest.data.sections)) {
			const sectionLines = exactLines.get(section) ?? [];
			expect(manifestEntry).toEqual({ records: sectionLines.length, sha256: createHash('sha256').update(sectionLines.join('')).digest('hex') });
		}
		expect(grouped.get('account')).toMatchObject([{ id: accountId }]);
		expect(grouped.get('clients')).toMatchObject([{ id: clientId, archivedAt: date.toISOString(), defaultRateOrePerHour: exact.toString() }]);
		expect(grouped.get('projects')).toMatchObject([{ id: projectId, clientId }]);
		expect(grouped.get('runningTimer')).toMatchObject([{ accountId, projectId, assignedRateOrePerHour: exact.toString() }]);
		expect(Buffer.from(grouped.get('reportSettings')![0]!.logoPngBase64, 'base64')).toEqual(await readFile('prototype/pdf/fixture-logo.png'));
		expect(grouped.get('entries')).toEqual(expect.arrayContaining([
			expect.objectContaining({ id: splitRootId, supersededAt: date.toISOString() }),
			expect.objectContaining({ id: splitChildId, splitFromEntryId: splitRootId, invoiceNumber: '00017' }),
			expect.objectContaining({ id: releasedId, deletedAt: date.toISOString() }),
			expect.objectContaining({ completion: 'incomplete', assignedRateOrePerHour: null, billableAmountOre: null }),
		]));
		expect(grouped.get('entryDayAllocations')!.filter(({ entryId }) => entryId === splitChildId)
			.map(({ amountOre, calculationVersion }) => [BigInt(amountOre), calculationVersion])).toEqual([[1n, 4], [0n, 4]]);
		const entries = new Set(grouped.get('entries')!.map(({ id }) => id));
		for (const { entryId } of grouped.get('entryDayAllocations')!) expect(entries.has(entryId)).toBe(true);
		expect(grouped.get('clockifyImportIdentities')).toMatchObject([{ entryId: correctedId, sourceSnapshot: { source: { description: 'Imported root' } } }]);
		expect(grouped.get('clockifyImportAliases')).toMatchObject([{ sourceSnapshot: { source: { description: 'Kept source' } } }]);
		expect(grouped.get('clockifyReleasedIdentities')).toMatchObject([{ entryId: releasedId, sourceSnapshot: { source: { description: 'Released root' } } }]);
		expect(grouped.get('clockifyImportBatches')).toEqual(expect.arrayContaining([expect.objectContaining({
			undoSnapshot: expect.objectContaining({ aliases: [expect.objectContaining({ sourceSnapshot: expect.objectContaining({
				source: expect.objectContaining({ description: 'Changed source' }),
			}) })] }),
			snapshot: expect.objectContaining({ correctionUpdates: [expect.objectContaining({
				entryId: correctedId, before: expect.objectContaining({ allocations: [expect.objectContaining({ calculationVersion: 1, amountOre: '0' })] }),
			})] }),
		})]));
		const originalCount = await database.entry.count();
		expect((await app.inject({ ...auth, method: 'HEAD', url: portableExportPath })).statusCode).toBe(404);
		expect(await database.entry.count()).toBe(originalCount);
	});

	it('matches Entries ordering within a date in both directions', async () => {
		const localDate = '2026-11-07';
		const records = [
			{ id: 'ffffffff-0000-0000-0000-000000000001', startAt: new Date('2026-11-07T07:00:00Z'), createdAt: new Date('2026-11-07T12:00:00Z') },
			{ id: '88888888-0000-0000-0000-000000000002', startAt: null, createdAt: new Date('2026-11-07T08:00:00Z') },
			{ id: '00000000-0000-0000-0000-000000000003', startAt: new Date('2026-11-07T09:00:00Z'), createdAt: new Date('2026-11-07T06:00:00Z') },
		];
		for (const row of records) {
			await database.entry.create({ data: {
				...row, accountId, localDate, description: 'CSV order test',
				kind: row.startAt ? 'timed' : 'duration-only', endAt: row.startAt ? new Date(row.startAt.getTime() + 1_000) : null,
				durationSeconds: 1, billable: false, billableAmountOre: 0n,
				allocations: { create: { localDate, seconds: 1, amountOre: 0n, calculationVersion: 1 } },
			} });
		}
		for (const sort of ['oldest', 'newest']) {
			const filters = new URLSearchParams({ from: localDate, to: localDate, sort, description: 'CSV order test' });
			const response = await app.inject({ ...auth, url: entriesCsvExportPath + '?' + filters });
			expect(response.statusCode, response.body).toBe(200);
			const csvIds = spreadsheetRows(response.body).slice(1).map((row) => row[1]);
			const list = parseWorkListResponse((await app.inject({ ...auth, url: workListPath + '?' + filters })).json());
			expect(csvIds).toEqual(list.groups.flatMap(({ rows }) => rows.map(({ entry }) => entry.id)));
			expect(csvIds).toEqual((sort === 'oldest' ? records : records.toReversed()).map(({ id }) => id));
		}
	});

	it('exports the filtered persisted portion with literal search and spreadsheet-safe text', async () => {
		const filters = new URLSearchParams({
			from: '2026-11-11', to: '2026-11-11', clientId, projectId,
			invoice: 'invoiced', billability: 'billable', invoiceNumber: '00017', description: 'sum(1;2)', sort: 'oldest',
		});
		const url = entriesCsvExportPath + '?' + filters;
		expect((await app.inject({ url })).statusCode).toBe(401);
		const response = await app.inject({ ...auth, url });
		expect(response.statusCode, response.body).toBe(200);
		expect(response.headers).toMatchObject({ 'content-type': 'text/csv; charset=utf-8', 'cache-control': 'no-store',
			'content-disposition': 'attachment; filename="timekeeper-entries-2026-11-11_to_2026-11-11.csv"' });
		expect(response.rawPayload.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
		const [header, row, ...rest] = spreadsheetRows(response.body);
		expect(rest).toEqual([]);
		expect(header).toContain('Belopp (öre)');
		expect(row).toEqual([
			'2026-11-11', splitChildId, 'Med start och slut', "'\u200b=client", "'Literal; project", '\' \t=SUM(1;2)\r\n"quoted"�',
			'2026-11-11T22:30:00.000Z', '2026-11-11T23:30:00.000Z', '1800', '00:30:00', 'Ja', '0,01', '1', '0,01', '1',
			'Ja', "'00017", '2026-11-13', "'\t+reference",
		]);
		const list = parseWorkListResponse((await app.inject({ ...auth, url: workListPath + '?' + filters })).json());
		expect(list.totals).toEqual({ seconds: Number(row![8]), amountOre: row![14] });
		filters.set('from', '2026-11-12');
		filters.set('to', '2026-11-12');
		const second = await app.inject({ ...auth, url: entriesCsvExportPath + '?' + filters });
		expect(spreadsheetRows(second.body)[1]?.[14]).toBe('0');
		expect((await app.inject({ ...auth, url: entriesCsvExportPath + '?page=1' })).statusCode).toBe(400);
	});
});

describe('Private export spool', () => {
	it('unlinks completed data before download and cleans failed or aborted captures', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'timekeeper-spool-test-'));
		try {
			const spool = createExportSpool(directory, 6);
			const produce = (text: string) => async (consume: (source: AsyncIterable<string>) => Promise<void>) => {
				await consume((async function* () { yield text; })());
			};
			const signal = new AbortController();
			const ready = await spool(produce('hello'), false, signal.signal);
			expect(await readdir(directory)).toEqual([]);
			await expect(spool(produce('busy'), false, signal.signal)).rejects.toMatchObject({ code: 'EXPORT_BUSY' });
			const chunks = [];
			for await (const chunk of ready.stream) chunks.push(chunk);
			expect(Buffer.concat(chunks).toString()).toBe('hello');
			await expect(spool(produce('too large'), true, signal.signal)).rejects.toMatchObject({ code: 'EXPORT_TOO_LARGE' });
			expect(await readdir(directory)).toEqual([]);
			const aborted = new AbortController();
			await expect(spool(async (consume) => consume((async function* () {
				yield 'data';
				aborted.abort();
			})()), false, aborted.signal)).rejects.toMatchObject({ name: 'AbortError' });
			expect(await readdir(directory)).toEqual([]);
			const next = await spool(produce('again'), false, signal.signal);
			next.stream.destroy();
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
