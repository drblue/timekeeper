import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
	authLoginPath,
	authSessionPath,
	clientsPath,
	csrfHeader,
	maxCatalogNameLength,
	maxCatalogNotesLength,
	maxHourlyRateOre,
	parseAuthSessionResponse,
	parseClientListResponse,
	parseClientResponse,
	parseProjectListResponse,
	parseProjectResponse,
	projectsPath,
} from '@timekeeper/contracts';
import type { CreateClientBody, CreateProjectBody } from '@timekeeper/contracts';
import type { InjectOptions } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { openDatabase } from '../src/auth/database.ts';
import { createAuthStore, provisionAccount } from '../src/auth/store.ts';
import { createCatalogStore } from '../src/catalog/store.ts';

const origin = 'https://timekeeper.example.test';
const email = 'owner@example.test';
const password = 'initial test password';
const csrfCookie = '__Host-timekeeper-csrf';
const sessionCookie = '__Host-timekeeper-session';

function client(name: string, fields: Partial<CreateClientBody> = {}): CreateClientBody {
	return { name, notes: null, defaultRateOrePerHour: null, ...fields };
}

function project(name: string, fields: Partial<CreateProjectBody> = {}): CreateProjectBody {
	return { name, notes: null, clientId: null, rateOverrideOrePerHour: null, ...fields };
}

describe('Client and project catalog', () => {
	let fixtureDirectory: string;
	let fixtureFile: string;
	let directory: string;
	let database: Awaited<ReturnType<typeof openDatabase>>;
	let app: Awaited<ReturnType<typeof createApp>>;
	let session: Pick<InjectOptions, 'cookies' | 'headers'>;

	beforeAll(async () => {
		fixtureDirectory = await mkdtemp(join(tmpdir(), 'timekeeper-catalog-migration-'));
		fixtureFile = join(fixtureDirectory, 'test.sqlite');
		execFileSync('npm', ['run', 'db:migrate'], {
			env: { ...process.env, TIMEKEEPER_DATABASE_URL: pathToFileURL(fixtureFile).href },
			stdio: 'pipe',
		});
	});

	afterAll(async () => {
		await rm(fixtureDirectory, { recursive: true, force: true });
	});

	async function signIn(address = email) {
		const visitor = await app.inject({ url: authSessionPath });
		const preAuth = parseAuthSessionResponse(visitor.json());
		const response = await app.inject({
			method: 'POST', url: authLoginPath, payload: { email: address, password },
			cookies: { [csrfCookie]: visitor.cookies.find((entry) => entry.name === csrfCookie)!.value },
			headers: { origin, [csrfHeader]: preAuth.csrfToken },
		});
		expect(response.statusCode).toBe(200);
		const current = parseAuthSessionResponse(response.json());
		return {
			cookies: { [sessionCookie]: response.cookies.find((entry) => entry.name === sessionCookie)!.value },
			headers: { origin, [csrfHeader]: current.csrfToken },
		};
	}

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), 'timekeeper-catalog-test-'));
		const filename = join(directory, 'test.sqlite');
		await copyFile(fixtureFile, filename);
		database = await openDatabase(pathToFileURL(filename).href);
		expect(await provisionAccount(database, email, password)).toBe(true);
		app = await createApp({
			auth: { config: { origin, trustedProxyAddresses: new Set() }, store: await createAuthStore(database) },
			catalog: createCatalogStore(database),
		});
		session = await signIn();
	});

	afterEach(async () => {
		await app?.close();
		await database?.$disconnect();
		await rm(directory, { recursive: true, force: true });
	});

	function request(method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) {
		return app.inject({ ...session, method, url, payload });
	}

	async function createClient(payload: CreateClientBody) {
		const response = await request('POST', clientsPath, payload);
		expect(response.statusCode, response.body).toBe(201);
		return parseClientResponse(response.json());
	}

	async function createProject(payload: CreateProjectBody) {
		const response = await request('POST', projectsPath, payload);
		expect(response.statusCode, response.body).toBe(201);
		return parseProjectResponse(response.json());
	}

	it('preserves exact öre, explicit zero, absent rates and default billability', async () => {
		const owner = await createClient(client('  Client AB  ', { defaultRateOrePerHour: maxHourlyRateOre, notes: '  Internal  ' }));
		expect(owner).toEqual({
			id: expect.any(String), name: 'Client AB', notes: 'Internal', defaultRateOrePerHour: maxHourlyRateOre,
			archivedAt: null, revision: 1,
		});
		const inherited = await createProject(project('Consulting', { clientId: owner.id }));
		const explicitZero = await createProject(project('Follow-up', { clientId: owner.id, rateOverrideOrePerHour: '0', defaultBillable: false }));
		const missingRate = await createProject(project('Internal'));
		expect(inherited).toMatchObject({ rateOverrideOrePerHour: null, effectiveRateOrePerHour: maxHourlyRateOre, defaultBillable: true });
		expect(explicitZero).toMatchObject({ rateOverrideOrePerHour: '0', effectiveRateOrePerHour: '0', defaultBillable: false });
		expect(missingRate).toMatchObject({ clientId: null, rateOverrideOrePerHour: null, effectiveRateOrePerHour: null });

		const edit = await request('PUT', `${clientsPath}/${owner.id}`, { ...client('Client AB', { defaultRateOrePerHour: '0' }), revision: owner.revision });
		expect(edit.statusCode).toBe(200);
		expect(parseClientResponse(edit.json())).toMatchObject({ defaultRateOrePerHour: '0', revision: 2 });
		const active = await request('GET', projectsPath);
		expect(active.headers['cache-control']).toBe('no-store');
		expect(parseProjectListResponse(active.json())).toEqual([
			{ ...inherited, effectiveRateOrePerHour: '0' }, explicitZero, missingRate,
		]);

		const clearRate = await request('PUT', `${clientsPath}/${owner.id}`, { ...client('Client AB'), revision: 2 });
		expect(clearRate.statusCode).toBe(200);
		expect(parseProjectListResponse((await request('GET', projectsPath)).json())).toEqual([
			{ ...inherited, effectiveRateOrePerHour: null }, explicitZero, missingRate,
		]);
	});

	it('archives without erasing identity, keeps child lifecycle independent and blocks new archived associations', async () => {
		const owner = await createClient(client('Parent client'));
		const child = await createProject(project('Original project', { clientId: owner.id, notes: 'History stays linked' }));
		const archive = await request('POST', `${clientsPath}/${owner.id}/archive`, { revision: owner.revision });
		expect(archive.statusCode).toBe(200);
		const archivedClient = parseClientResponse(archive.json());
		expect(archivedClient).toMatchObject({ id: owner.id, revision: 2, archivedAt: expect.any(String) });
		expect(parseClientListResponse((await request('GET', clientsPath)).json())).toEqual([]);
		expect(parseClientListResponse((await request('GET', `${clientsPath}?view=management`)).json())).toEqual([archivedClient]);
		expect(parseProjectListResponse((await request('GET', projectsPath)).json())).toEqual([]);
		expect(parseProjectListResponse((await request('GET', `${projectsPath}?view=management`)).json())).toEqual([child]);
		expect((await request('POST', projectsPath, project('New project', { clientId: owner.id }))).json())
			.toMatchObject({ code: 'INVALID_CLIENT' });
		const unrelated = await createProject(project('Standalone'));
		expect((await request('PUT', `${projectsPath}/${unrelated.id}`, {
			...project('Standalone', { clientId: owner.id }), revision: unrelated.revision, defaultBillable: true,
		})).json()).toMatchObject({ code: 'INVALID_CLIENT' });

		const archiveChild = await request('POST', `${projectsPath}/${child.id}/archive`, { revision: child.revision });
		expect(archiveChild.statusCode).toBe(200);
		const renamed = await request('PUT', `${projectsPath}/${child.id}`, {
			...project('Renamed project', { clientId: owner.id, notes: child.notes }), revision: 2, defaultBillable: true,
		});
		expect(renamed.statusCode).toBe(200);
		expect(parseProjectResponse(renamed.json())).toMatchObject({
			id: child.id, clientId: owner.id, name: 'Renamed project', notes: child.notes,
			archivedAt: parseProjectResponse(archiveChild.json()).archivedAt, revision: 3,
		});
		const restoreClient = await request('POST', `${clientsPath}/${owner.id}/restore`, { revision: 2 });
		expect(restoreClient.statusCode).toBe(200);
		expect(parseClientResponse(restoreClient.json())).toEqual({ ...owner, revision: 3 });
		expect(parseProjectListResponse((await request('GET', `${projectsPath}?view=active`)).json())).toEqual([unrelated]);
		const restoreChild = await request('POST', `${projectsPath}/${child.id}/restore`, { revision: 3 });
		expect(restoreChild.statusCode).toBe(200);
		const restored = { ...child, name: 'Renamed project', revision: 4 };
		expect(parseProjectResponse(restoreChild.json())).toEqual(restored);
		expect(parseProjectListResponse((await request('GET', projectsPath)).json())).toEqual([restored, unrelated]);
	});

	it('warns before storing duplicate names in the applicable scope and allows explicit confirmation', async () => {
		const first = await createClient(client('Ångström'));
		await request('POST', `${clientsPath}/${first.id}/archive`, { revision: first.revision });
		const equivalent = client('  A\u030angstro\u0308m  ');
		const duplicate = await request('POST', clientsPath, equivalent);
		expect(duplicate.statusCode).toBe(409);
		expect(duplicate.json()).toMatchObject({ code: 'DUPLICATE_CLIENT_NAME' });
		expect(await database.client.count()).toBe(1);
		const second = await createClient({ ...equivalent, confirmDuplicate: true });
		expect(second.id).not.toBe(first.id);
		const clientEdit = await request('PUT', `${clientsPath}/${second.id}`, {
			...client(second.name, { notes: 'Distinct record' }), revision: second.revision,
		});
		expect(clientEdit.statusCode).toBe(200);
		const other = await createClient(client('Other client'));
		const firstProject = await createProject(project('Website', { clientId: second.id }));
		const secondProject = await createProject(project('Website', { clientId: other.id }));
		const standalone = await createProject(project('Website'));
		expect((await request('POST', projectsPath, project('Website'))).json()).toMatchObject({ code: 'DUPLICATE_PROJECT_NAME' });
		expect((await request('POST', projectsPath, project(' website ', { clientId: second.id }))).json())
			.toMatchObject({ code: 'DUPLICATE_PROJECT_NAME' });
		const move = { ...project('Website', { clientId: second.id }), defaultBillable: true, revision: secondProject.revision };
		expect((await request('PUT', `${projectsPath}/${secondProject.id}`, move)).json())
			.toMatchObject({ code: 'DUPLICATE_PROJECT_NAME' });
		expect(await database.project.count()).toBe(3);
		const confirmed = await request('PUT', `${projectsPath}/${secondProject.id}`, { ...move, confirmDuplicate: true });
		expect(confirmed.statusCode).toBe(200);
		expect(parseProjectResponse(confirmed.json())).toMatchObject({ id: secondProject.id, clientId: second.id });
		expect(parseProjectListResponse((await request('GET', projectsPath)).json()).map(({ id }) => id).sort())
			.toEqual([firstProject.id, secondProject.id, standalone.id].sort());
	});

	it('serializes competing duplicate checks and rejects stale updates and lifecycle actions', async () => {
		const created = await Promise.all([
			request('POST', clientsPath, client('Same client')),
			request('POST', clientsPath, client('Same client')),
		]);
		expect(created.map(({ statusCode }) => statusCode).sort()).toEqual([201, 409]);
		const [record] = parseClientListResponse((await request('GET', clientsPath)).json());
		expect(record).toBeDefined();
		const changed = await Promise.all([
			request('PUT', `${clientsPath}/${record!.id}`, { ...client('Rename'), revision: 1 }),
			request('POST', `${clientsPath}/${record!.id}/archive`, { revision: 1 }),
		]);
		expect(changed.map(({ statusCode }) => statusCode).sort()).toEqual([200, 409]);
		expect(changed.find(({ statusCode }) => statusCode === 409)?.json()).toMatchObject({ code: 'REVISION_CONFLICT' });
		expect(parseClientListResponse((await request('GET', `${clientsPath}?view=management`)).json())[0]?.revision).toBe(2);
	});

	it('rejects anonymous access, invalid CSRF, and invalid values before writing', async () => {
		expect((await app.inject({ url: clientsPath })).statusCode).toBe(401);
		expect((await app.inject({ ...session, method: 'POST', url: projectsPath, payload: project('Rejected'), headers: { origin } })).json())
			.toMatchObject({ code: 'CSRF_REJECTED' });
		for (const rate of [-1, '1.5', '01', '1e2']) {
			expect((await request('POST', clientsPath, { ...client('Invalid'), defaultRateOrePerHour: rate })).json())
				.toMatchObject({ code: 'INVALID_REQUEST' });
		}
		expect((await request('POST', clientsPath, client('Invalid', { defaultRateOrePerHour: '9223372036854775808' }))).json())
			.toMatchObject({ code: 'INVALID_HOURLY_RATE', fieldErrors: [{ field: 'body/defaultRateOrePerHour', message: expect.any(String) }] });
		expect((await request('POST', clientsPath, client('  '))).json()).toMatchObject({ code: 'INVALID_NAME' });
		expect((await request('POST', projectsPath, { ...project('Invalid'), accountId: randomUUID() })).json())
			.toMatchObject({ code: 'INVALID_REQUEST' });
		expect((await request('GET', `${projectsPath}?view=unknown`)).statusCode).toBe(400);
		expect(await database.client.count()).toBe(0);
		expect(await database.project.count()).toBe(0);
	});

	it('applies the same Unicode code point limits to names and notes on create, edit and read', async () => {
		const name = '🌱'.repeat(maxCatalogNameLength);
		const notes = '🌳'.repeat(maxCatalogNotesLength);
		const record = await createClient(client(name, { notes }));
		expect(record).toMatchObject({ name, notes });
		expect((await request('POST', clientsPath, client(`${name}🌱`))).statusCode).toBe(400);
		expect((await request('POST', projectsPath, project('Other', { notes: `${notes}🌳` }))).statusCode).toBe(400);
		const task = await createProject(project(name, { notes, clientId: record.id }));
		const updated = await request('PUT', `${projectsPath}/${task.id}`, {
			...project(name, { notes, clientId: record.id }), revision: 1, defaultBillable: false,
		});
		expect(updated.statusCode).toBe(200);
		expect(parseProjectListResponse((await request('GET', projectsPath)).json())).toEqual([
			{ ...task, defaultBillable: false, revision: 2 },
		]);
	});

	it('scopes records and related IDs to the authenticated owner at API and persistence boundaries', async () => {
		const owner = await database.account.findUniqueOrThrow({ where: { email } });
		const foreignEmail = 'foreign@example.test';
		const foreignId = randomUUID();
		// Provision a second account only for this test of the shared persistence boundary.
		await database.$executeRaw`PRAGMA ignore_check_constraints = ON`;
		try {
			await database.account.create({
				data: { id: foreignId, ownerSlot: 2, email: foreignEmail, passwordHash: owner.passwordHash },
			});
		} finally {
			await database.$executeRaw`PRAGMA ignore_check_constraints = OFF`;
		}
		const firstSession = session;
		const ownedClient = await createClient(client('Private client'));
		const ownedProject = await createProject(project('Private project', { clientId: ownedClient.id }));

		session = await signIn(foreignEmail);
		expect(parseClientListResponse((await request('GET', `${clientsPath}?view=management`)).json())).toEqual([]);
		expect(parseProjectListResponse((await request('GET', `${projectsPath}?view=management`)).json())).toEqual([]);
		const foreignClient = await createClient(client('Private client'));
		const foreignProject = await createProject(project('Private project', { clientId: foreignClient.id }));
		expect((await request('PUT', `${clientsPath}/${ownedClient.id}`, { ...client('Foreign edit'), revision: 1 })).statusCode).toBe(404);
		expect((await request('POST', `${projectsPath}/${ownedProject.id}/archive`, { revision: 1 })).statusCode).toBe(404);
		const invalidClient = await request('POST', projectsPath, project('Foreign association', { clientId: ownedClient.id }));
		expect(invalidClient.statusCode).toBe(422);
		expect(invalidClient.json()).toMatchObject({ code: 'INVALID_CLIENT' });
		await expect(database.project.create({
			data: { id: randomUUID(), accountId: foreignId, clientId: ownedClient.id, name: 'Foreign association' },
		})).rejects.toMatchObject({ code: 'P2003' });

		session = firstSession;
		expect(parseClientListResponse((await request('GET', `${clientsPath}?view=management`)).json())).toEqual([ownedClient]);
		expect(parseProjectListResponse((await request('GET', `${projectsPath}?view=management`)).json())).toEqual([ownedProject]);
		expect((await request('PUT', `${projectsPath}/${foreignProject.id}`, { ...project('Foreign edit'), defaultBillable: true, revision: 1 })).statusCode)
			.toBe(404);
	});
});
