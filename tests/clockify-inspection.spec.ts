import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { clientsPath, clockifyPreviewPath, entriesPath, projectsPath } from '@timekeeper/contracts';

const headers = [
	'Project', 'Client', 'Description', 'Task', 'User', 'Group', 'Email', 'Tags', 'Start Date', 'Start Time',
	'End Date', 'End Time', 'Duration (h)', 'Duration (decimal)', 'Date of creation',
];

function record(description: string, {
	user = 'Alva Example', email = 'alva@example.test', tags = '', date = '25/10/2026',
	start = '09:00:00', end = '10:00:00', duration = '01:00:00',
} = {}) {
	return ['A project', 'A client', description, '', user, '', email, tags, date, start, date, end, duration, '1.00', date]
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
