import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { entriesPath, parseEntryListResponse } from '@timekeeper/contracts';

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

test('reviews identical rows, preserves accepted copies after overlap, and leaves canceled work untouched', async ({ page }) => {
	await signIn(page);
	const before = parseEntryListResponse(await (await page.request.get(entriesPath)).json());
	const duplicate = record('Duplicate November handoff', { date: '27/11/2026' });
	const overlap = record('New overlapping export row', { date: '28/11/2026' });
	const review = page.getByRole('region', { name: 'Review import' });
	const prepare = async (name: string, lines: string[], configure: boolean) => {
		await page.getByLabel('Clockify CSV file').setInputFiles(file(name, [headers.join(','), ...lines]));
		await page.getByRole('button', { name: 'Inspect file' }).click();
		await page.getByRole('button', { name: 'Prepare import', exact: true }).click();
		if (configure) {
			const mapping = page.getByRole('group', { name: 'A client · A project' });
			await mapping.getByLabel('Client', { exact: true }).selectOption('none');
			await mapping.getByLabel('Project', { exact: true }).selectOption('none');
			await page.getByRole('group', { name: 'Default historical billing' }).getByLabel('Billing').selectOption('non-billable');
		}
		await page.getByRole('button', { name: 'Review import choices' }).click();
		await expect(review.getByRole('heading', { name: 'Review import' })).toBeFocused();
	};

	await page.goto('/imports/clockify');
	await prepare('duplicate.csv', [duplicate, duplicate], true);
	const copies = review.getByRole('spinbutton', { name: 'Copies to keep · group at line 2' });
	await expect(copies).toHaveValue('1');
	await expect(review).toContainText('Previously accepted0');
	await expect(review).toContainText('Identical copies omitted1');
	await expect(review).toContainText('Source lines 2, 3');
	await copies.fill('0');
	await expect(review.getByRole('button', { name: 'Update review' })).toBeDisabled();
	await expect(review.getByRole('button', { name: 'Confirm import' })).toHaveCount(0);
	await copies.fill('2');
	await expect(review.getByRole('button', { name: 'Confirm import' })).toHaveCount(0);
	await review.getByRole('button', { name: 'Update review' }).click();
	await expect(review.getByRole('heading', { name: 'Review import' })).toBeFocused();
	await expect(review).toContainText('Accepted in review2');
	await page.getByRole('link', { name: 'Back to time entries' }).click();
	await expect(page.getByRole('link', { name: 'Import Clockify CSV' })).toBeFocused();
	expect(parseEntryListResponse(await (await page.request.get(entriesPath)).json())).toEqual(before);

	await page.getByRole('link', { name: 'Import Clockify CSV' }).click();
	await prepare('fresh.csv', [duplicate, duplicate], true);
	await copies.fill('2');
	await review.getByRole('button', { name: 'Update review' }).click();
	await review.getByRole('button', { name: 'Confirm import' }).click();
	const done = page.getByRole('region', { name: 'Import complete' });
	await expect(done).toContainText('New entries2');

	await done.getByRole('button', { name: 'Inspect another file' }).click();
	await prepare('reordered.csv', [duplicate, overlap, duplicate], true);
	await expect(review.getByRole('spinbutton')).toHaveValue('2');
	await expect(review).toContainText('Previously accepted2');
	await expect(review).toContainText('Already imported2');
	await expect(review).toContainText('Source lines 2, 4');
	await review.getByRole('button', { name: 'Confirm import' }).click();
	await expect(done).toContainText('New entries1');

	await done.getByRole('button', { name: 'Inspect another file' }).click();
	await prepare('partial-overlap.csv', [overlap, duplicate], false);
	await expect(review).toContainText('Already imported2');
	await expect(review.getByRole('spinbutton')).toHaveCount(0);
	await review.getByRole('button', { name: 'Confirm no changes' }).click();
	await expect(page.getByRole('region', { name: 'No new entries imported' })).toContainText('Already imported2');
	const final = parseEntryListResponse(await (await page.request.get(entriesPath)).json());
	expect(final.filter((entry) => entry.description === 'Duplicate November handoff')).toHaveLength(2);
	expect(final.filter((entry) => entry.description === 'New overlapping export row')).toHaveLength(1);
	expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
});
