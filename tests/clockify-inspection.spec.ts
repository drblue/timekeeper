import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
	authSessionPath, clientsPath, clockifyCommitPath, clockifyPreviewPath, csrfHeader, entriesPath, idempotencyKeyHeader,
	parseAuthSessionResponse, parseClientListResponse, parseClientResponse, parseEntryListResponse, parseProjectListResponse, projectsPath,
} from '@timekeeper/contracts';

const headers = [
	'Project', 'Client', 'Description', 'Task', 'User', 'Group', 'Email', 'Tags', 'Start Date', 'Start Time',
	'End Date', 'End Time', 'Duration (h)', 'Duration (decimal)', 'Date of creation',
];

function record(description: string, {
	client = 'A client', user = 'Alva Example', email = 'alva@example.test', tags = '', date = '25/10/2026',
	start = '09:00:00', end = '10:00:00', duration = '01:00:00',
} = {}) {
	return ['A project', client, description, '', user, '', email, tags, date, start, date, end, duration, '1.00', date]
		.map((field) => '"' + field.replaceAll('"', '""') + '"').join(',');
}

function file(name: string, lines: string[]) {
	return { name, mimeType: 'text/csv', buffer: Buffer.from(lines.join('\r\n') + '\r\n') };
}

async function signIn(page: Page) {
	await page.goto('/login');
	await page.getByLabel('Email address').fill('operator@example.test');
	await page.getByLabel('Password', { exact: true }).fill('Browser test initial password');
	await page.getByRole('button', { name: 'Sign in' }).click();
	await page.getByRole('link', { name: 'Entries', exact: true }).waitFor();
}

test('requires a user, exposes exact durations and daylight-saving issues, and leaves workspace data unchanged', async ({ page }) => {
	await signIn(page);
	const readWorkspace = () => Promise.all([entriesPath, clientsPath, projectsPath].map(async (path) => {
		const result = await page.request.get(path);
		expect(result.ok()).toBe(true);
		return result.json();
	}));
	const before = await readWorkspace();
	await page.goto('/entries?preset=custom&from=2026-10-20&to=2026-10-27&description=%5B.*%5D&sort=oldest');
	const open = page.getByRole('link', { name: 'Import Clockify CSV' });
	await open.press('Enter');
	await expect(page.getByRole('heading', { name: 'Inspect Clockify export' })).toBeFocused();
	const picker = page.getByLabel('Clockify CSV file');
	const zone = page.getByLabel('Source time zone');
	await expect(zone).toHaveValue('Europe/Stockholm');
	await picker.setInputFiles(file('synthetic-clocking.csv', [
		'\uFEFF' + headers.join(','),
		record('Review, "design"\nnotes', { tags: 'consulting, Invoiced', start: '09:00:00', end: '09:00:03', duration: '00:00:03' }),
		record('Autumn handover', { start: '02:15:00', end: '03:15:00' }),
		record('Timestamp mismatch', { start: '10:00:00', end: '10:15:00', duration: '00:10:00' }),
		record('Bad duration', { duration: 'oops' }),
		record('Reversed interval', { start: '11:00:00', end: '10:30:00' }),
		record('Other source user', { user: 'Bo Example', email: 'bo@example.test' }),
		'malformed,row',
	]));
	await page.getByRole('button', { name: 'Inspect file' }).click();
	const user = page.getByLabel('Clockify user');
	await expect(user).toBeFocused();
	await expect(user).toHaveValue('');
	const results = page.getByRole('region', { name: 'Inspection results' });
	await expect(results).toContainText('Choose a Clockify user');
	await expect(results).not.toContainText('Autumn handover');
	await page.getByRole('button', { name: 'Inspect selection' }).click();
	await expect(user).toBeFocused();
	await expect(page.getByRole('alert')).toContainText('Choose the user');
	const alva = await user.getByRole('option', { name: /Alva Example/ }).getAttribute('value');
	await user.selectOption(alva!);
	await expect(results).toHaveCount(0);
	await page.getByRole('button', { name: 'Inspect selection' }).click();
	await expect(results.getByRole('heading', { name: 'Inspection results' })).toBeFocused();
	await expect(results).toContainText('Rows in file7');
	await expect(results).toContainText('Selected rows5');
	await expect(results).toContainText('Valid1');
	await expect(results).toContainText('Needs review2');
	await expect(results).toContainText('Invalid3');
	await expect(results).toContainText('1 invalid row has no identifiable user.');
	await expect(results).toContainText('Earlier UTC+02:00 or Later UTC+01:00');
	await expect(results).toContainText('Duration (h) differs from the elapsed time');
	await expect(results).toContainText('This row has the wrong number of columns.');
	await expect(results.getByText('−00:30:00', { exact: true })).toBeVisible();
	await expect(results).not.toContainText('Other source user');
	await results.getByRole('strong').filter({ hasText: 'Review, "design" notes' }).click();
	await expect(results.getByText('Present', { exact: true })).toBeVisible();
	const quotedRow = results.getByRole('listitem').filter({ has: page.getByText('Review, "design" notes', { exact: true }) });
	await quotedRow.getByText('Source metadata', { exact: true }).click();
	await expect(quotedRow.getByText('Duration (decimal)', { exact: true })).toBeVisible();
	await expect(results.getByText('00:00:03', { exact: true }).first()).toBeVisible();
	const search = new URL(page.url()).search;
	expect(search).not.toContain('synthetic-clocking');
	expect(search).not.toContain('example.test');
	await zone.fill('UTC');
	await expect(results).toHaveCount(0);
	await page.getByRole('button', { name: 'Inspect selection' }).click();
	await expect(results).toContainText('Needs review1');
	await expect(results).not.toContainText('occurs twice');
	await page.getByRole('link', { name: 'Cancel inspection' }).click();
	await expect(open).toBeFocused();
	const returned = new URL(page.url()).searchParams;
	expect(returned.get('description')).toBe('[.*]');
	expect(returned.get('sort')).toBe('oldest');
	expect(await readWorkspace()).toEqual(before);
	await open.click();
	await expect(picker).toHaveValue('');
	await expect(results).toHaveCount(0);
	expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
});

test('recovers unsupported headers, bad timezone and a failed inspection without losing the chosen file', async ({ page }) => {
	await signIn(page);
	await page.goto('/imports/clockify');
	const picker = page.getByLabel('Clockify CSV file');
	const zone = page.getByLabel('Source time zone');
	const inspect = page.getByRole('button', { name: 'Inspect file' });
	await picker.setInputFiles(file('wrong.csv', ['unexpected,headings', 'one,two']));
	await inspect.click();
	await expect(page.getByRole('alert')).toContainText('required Clockify headers');
	await expect(picker).toBeFocused();
	await picker.setInputFiles(file('fixed.csv', [headers.join(','), record('A valid synthetic row')]));
	await zone.fill('Invalid/Zone');
	await inspect.click();
	await expect(page.getByRole('alert')).toContainText('Enter an IANA time zone');
	await expect(zone).toBeFocused();
	await zone.fill('Europe/Stockholm');
	await page.route('**' + clockifyPreviewPath + '?*', (route) => route.abort(), { times: 1 });
	await inspect.click();
	await expect(page.getByRole('alert')).toContainText('Could not inspect the file');
	await expect(page.getByRole('alert')).toBeFocused();
	await inspect.click();
	const results = page.getByRole('region', { name: 'Inspection results' });
	await expect(results).toContainText('A valid synthetic row');
	await expect(page.getByLabel('Clockify user')).toHaveCount(0);
	await expect(results).toContainText('Alva Example');
	expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
});

test('reviews historical billing and catalog creation, then retries a committed import without duplicate entries', async ({ page }) => {
	await signIn(page);
	await page.goto('/imports/clockify');
	const picker = page.getByLabel('Clockify CSV file');
	const csv = [
		headers.join(','),
		...Array.from({ length: 29 }, (_, index) => record('Synthetic import ' + String(index + 1).padStart(2, '0'), {
			date: String(index + 1).padStart(2, '0') + '/11/2026',
			tags: index < 12 ? 'invoiced' : '',
		})),
	];
	await picker.setInputFiles(file('synthetic-november.csv', csv));
	await page.getByRole('button', { name: 'Inspect file' }).click();
	await page.getByRole('button', { name: 'Prepare import', exact: true }).click();
	const group = page.getByRole('group', { name: 'A client · A project' });
	await group.getByLabel('Client', { exact: true }).selectOption('create');
	await group.getByLabel('Project', { exact: true }).selectOption('create');
	const billing = page.getByRole('group', { name: 'Default historical billing' });
	await billing.getByLabel('Billing', { exact: true }).selectOption('billable');
	await billing.getByLabel('Historical hourly rate (SEK)').fill('850,50');
	const rowChoices = page.getByRole('region', { name: 'Row choices' });
	const row = rowChoices.getByRole('listitem').filter({ hasText: 'Synthetic import 14' });
	await row.getByText('Synthetic import 14', { exact: true }).click();
	await row.getByLabel('Billing', { exact: true }).selectOption('non-billable');
	await page.getByRole('button', { name: 'Review import choices' }).click();
	const review = page.getByRole('region', { name: 'Review import' });
	await expect(review.getByRole('heading', { name: 'Review import' })).toBeFocused();
	await expect(review).toContainText('New entries29');
	await expect(review).toContainText('Invoiced12');
	await expect(review).toContainText('Project · A project · A client');
	await review.getByText('Review source rows').click();
	await expect(review).toContainText(/850,50\sSEK\/h/);
	await expect(review).toContainText('Non-billable');
	expect((await (await page.request.get(entriesPath)).json()).length).toBe(0);
	expect((await (await page.request.get(clientsPath)).json()).length).toBe(0);
	expect((await (await page.request.get(projectsPath)).json()).length).toBe(0);
	expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);

	const attempts: { key: string | undefined; body: unknown }[] = [];
	await page.route('**' + clockifyCommitPath, async (route) => {
		attempts.push({ key: route.request().headers()[idempotencyKeyHeader], body: route.request().postDataJSON() });
		if (attempts.length > 1) return route.continue();
		expect((await route.fetch()).status()).toBe(200);
		await route.abort();
	});
	await review.getByRole('button', { name: 'Confirm import', exact: true }).click();
	await expect(page.getByRole('alert')).toContainText('Could not confirm the import');
	await page.reload();
	await page.getByRole('button', { name: 'Retry confirmation' }).click();
	const done = page.getByRole('region', { name: 'Import complete' });
	await expect(done).toContainText('New entries29');
	await expect(done).toContainText('Invoiced12');
	expect(attempts[0]?.key).toBeTruthy();
	expect(attempts).toEqual([attempts[0], attempts[0]]);
	const entries = parseEntryListResponse(await (await page.request.get(entriesPath)).json());
	expect(entries).toHaveLength(29);
	expect(entries.filter((entry) => entry.invoicedAt)).toHaveLength(12);
	expect(entries.find((entry) => entry.description === 'Synthetic import 14')?.billable).toBe(false);
	const clients = parseClientListResponse(await (await page.request.get(clientsPath)).json());
	const projects = parseProjectListResponse(await (await page.request.get(projectsPath)).json());
	expect(clients).toMatchObject([{ name: 'A client', defaultRateOrePerHour: null }]);
	expect(projects).toMatchObject([{ name: 'A project', rateOverrideOrePerHour: null }]);

	await done.getByRole('button', { name: 'Inspect another file' }).click();
	await expect(picker).toHaveValue('');
	await picker.setInputFiles(file('renamed-reordered.csv', [csv[0]!, ...csv.slice(1).reverse()]));
	await page.getByRole('button', { name: 'Inspect file' }).click();
	await page.getByRole('button', { name: 'Prepare import', exact: true }).click();
	await page.getByRole('button', { name: 'Review import choices' }).click();
	await expect(review).toContainText('Already imported29');
	await review.getByRole('button', { name: 'Confirm no changes' }).click();
	await expect(page.getByRole('region', { name: 'No new entries imported' })).toContainText('Already imported29');
	expect(parseEntryListResponse(await (await page.request.get(entriesPath)).json())).toEqual(entries);
});

test('blocks unresolved rows and imports only explicitly reviewed incomplete work', async ({ page }) => {
	await signIn(page);
	await page.goto('/imports/clockify');
	await page.getByLabel('Clockify CSV file').setInputFiles(file('incomplete.csv', [
		headers.join(','),
		record('', { date: '08/12/2026' }),
		'malformed,row',
	]));
	await page.getByRole('button', { name: 'Inspect file' }).click();
	await page.getByRole('button', { name: 'Prepare import', exact: true }).click();
	await page.getByRole('checkbox', { name: 'Use one client and project for all rows' }).check();
	const mapping = page.getByRole('group', { name: 'Default mapping' });
	await mapping.getByLabel('Client', { exact: true }).selectOption('none');
	await mapping.getByLabel('Project', { exact: true }).selectOption('none');
	const billing = page.getByRole('group', { name: 'Default historical billing' });
	await billing.getByLabel('Billing', { exact: true }).selectOption('billable');
	await page.getByRole('button', { name: 'Review import choices' }).click();
	const review = page.getByRole('region', { name: 'Review import' });
	await expect(review).toContainText('Blocked2');
	await expect(review.getByRole('button', { name: 'Confirm import' })).toHaveCount(0);
	await review.getByRole('button', { name: 'Edit import choices' }).click();
	const rows = page.getByRole('region', { name: 'Row choices' });
	await rows.getByText('Line 2 · 01:00:00', { exact: true }).click();
	await rows.getByLabel('Accept missing description or rate as incomplete').check();
	await rows.getByText('Line 3', { exact: true }).click();
	await rows.getByLabel('Exclude row 3').check();
	await page.getByRole('button', { name: 'Review import choices' }).click();
	await expect(review).toContainText('Excluded1');
	await expect(review).toContainText('Incomplete1');
	await review.getByRole('button', { name: 'Confirm import', exact: true }).click();
	await expect(page.getByRole('region', { name: 'Import complete' })).toContainText('Incomplete1');
	const entries = parseEntryListResponse(await (await page.request.get(entriesPath)).json());
	expect(entries.find((entry) => entry.localDate === '2026-12-08')).toMatchObject({ completion: 'incomplete', description: '', assignedRateOrePerHour: null });
});

test('distinguishes same-named clients when confirming new projects', async ({ page }) => {
	await signIn(page);
	const session = parseAuthSessionResponse(await (await page.request.get(authSessionPath)).json());
	const requestHeaders = { Origin: new URL(page.url()).origin, [csrfHeader]: session.csrfToken };
	async function createClient() {
		const response = await page.request.post(clientsPath, {
			headers: requestHeaders, data: { name: 'Same-name parent', defaultRateOrePerHour: null, notes: null, confirmDuplicate: true },
		});
		expect(response.status()).toBe(201);
		return parseClientResponse(await response.json());
	}
	const first = await createClient();
	const second = await createClient();
	await page.goto('/imports/clockify');
	await page.getByLabel('Clockify CSV file').setInputFiles(file('same-names.csv', [
		headers.join(','),
		record('First mapped row', { client: 'First source parent', date: '12/12/2026' }),
		record('Second mapped row', { client: 'Second source parent', date: '13/12/2026' }),
	]));
	await page.getByRole('button', { name: 'Inspect file' }).click();
	await page.getByRole('button', { name: 'Prepare import', exact: true }).click();
	const mappings = [
		{ source: 'First source parent', id: first.id },
		{ source: 'Second source parent', id: second.id },
	];
	for (const { source, id } of mappings) {
		const mapping = page.getByRole('group', { name: source + ' · A project' });
		const client = mapping.getByLabel('Client', { exact: true });
		await expect(client.getByRole('option', { name: 'Same-name parent · ID ' + id.slice(0, 8) })).toBeAttached();
		await client.selectOption(id);
		await mapping.getByLabel('Project', { exact: true }).selectOption('create');
	}
	await page.getByRole('group', { name: 'Default historical billing' }).getByLabel('Billing').selectOption('non-billable');
	await page.getByRole('button', { name: 'Review import choices' }).click();
	const review = page.getByRole('region', { name: 'Review import' });
	await review.getByText('Review source rows').click();
	for (const { id } of mappings) {
		const parent = 'Same-name parent · ID ' + id.slice(0, 8) + ' (existing)';
		await expect(review.getByText('Project · A project · ' + parent, { exact: true })).toBeVisible();
		await expect(review.getByText(parent + ' · A project (new)', { exact: true })).toBeVisible();
	}
	await review.getByRole('button', { name: 'Confirm import', exact: true }).click();
	await expect(page.getByRole('region', { name: 'Import complete' })).toContainText('New entries2');
	const projects = parseProjectListResponse(await (await page.request.get(projectsPath)).json());
	expect(projects.filter((project) => project.name === 'A project').map((project) => project.clientId))
		.toEqual(expect.arrayContaining([first.id, second.id]));
});
