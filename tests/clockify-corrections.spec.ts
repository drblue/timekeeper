import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { authSessionPath, csrfHeader, entriesPath, parseAuthSessionResponse, parseEntryListResponse, parseEntryResponse } from '@timekeeper/contracts';
import { file, headers, record, signIn } from './clockify-fixture.js';

async function prepare(page: Page, name: string, records: string[], rate?: string) {
	await page.getByLabel('Clockify CSV file').setInputFiles(file(name, [headers.join(','), ...records]));
	await page.getByRole('button', { name: 'Inspect file' }).click();
	await page.getByRole('button', { name: 'Prepare import', exact: true }).click();
	if (rate !== undefined) {
		const mapping = page.getByRole('group', { name: 'A client · A project' });
		await mapping.getByLabel('Client', { exact: true }).selectOption('none');
		await mapping.getByLabel('Project', { exact: true }).selectOption('none');
		const billing = page.getByRole('group', { name: 'Default historical billing' });
		await billing.getByLabel('Billing', { exact: true }).selectOption('billable');
		await billing.getByLabel('Historical hourly rate (SEK)').fill(rate);
	}
}

const reviewFor = (page: Page) => page.getByRole('region', { name: 'Review import' });

async function reviewChoices(page: Page) {
	await page.getByRole('button', { name: 'Review import choices' }).click();
	await expect(reviewFor(page).getByRole('heading', { name: 'Review import' })).toBeFocused();
}

async function confirm(page: Page) {
	await reviewFor(page).getByRole('button', { name: 'Confirm import', exact: true }).click();
	return page.getByRole('region', { name: 'Import complete' });
}

async function entries(page: Page) {
	return parseEntryListResponse(await (await page.request.get(entriesPath)).json());
}

test('updates a correction, manually keeps invoiced work, and remembers both aliases', async ({ page }) => {
	await signIn(page);
	await page.goto('/imports/clockify');
	const original = record('Original source notes', { date: '03/12/2026' });
	const invoiced = record('Already invoiced source', { date: '13/12/2026', tags: 'Invoiced' });
	const incoming = record('Corrected source notes', { date: '03/12/2026' });
	const moved = record('Moved export row', { date: '14/12/2026' });
	await prepare(page, 'first.csv', [original, invoiced], '800');
	await reviewChoices(page);
	const first = await confirm(page);
	await expect(first).toContainText('New entries2');
	await first.getByRole('button', { name: 'Inspect another file' }).click();
	const imported = await entries(page);
	const entry = imported.find((item) => item.description === 'Original source notes')!;
	const locked = imported.find((item) => item.description === 'Already invoiced source')!;
	const session = parseAuthSessionResponse(await (await page.request.get(authSessionPath)).json());
	const response = await page.request.put(entriesPath + '/' + entry.id, {
		headers: { Origin: new URL(page.url()).origin, [csrfHeader]: session.csrfToken },
		data: { revision: entry.revision, description: 'Local saved description', projectId: null, directClientId: null,
			billable: true, rate: { mode: 'override', rateOrePerHour: '95000' } },
	});
	expect(response.status()).toBe(200);
	const local = parseEntryResponse(await response.json());

	await prepare(page, 'corrected.csv', [incoming, moved]);
	const row = page.getByRole('region', { name: 'Row choices' }).getByRole('listitem').filter({ hasText: 'Moved export row' });
	await row.getByRole('strong').filter({ hasText: 'Moved export row' }).click();
	await row.getByText('Match to previously imported work', { exact: true }).click();
	await row.getByText('Find another imported entry', { exact: true }).click();
	await row.getByRole('searchbox', { name: 'Search imported entries' }).fill('Already invoiced source');
	await row.getByRole('button', { name: 'Search imported entries', exact: true }).click();
	await row.getByRole('button', { name: /Choose Already invoiced source/ }).click();
	await expect(row).toContainText('Unmark the saved invoice');
	await expect(row.getByRole('option', { name: 'Update existing entry' })).toBeDisabled();
	await row.getByLabel('Correction action').selectOption('keep');

	await reviewChoices(page);
	const review = reviewFor(page);
	const correction = review.getByRole('group', { name: 'Correction for line 2' });
	await expect(correction.getByRole('heading', { name: 'Incoming Clockify row' })).toBeVisible();
	await expect(correction.getByRole('heading', { name: 'Compared Clockify row' })).toBeVisible();
	await expect(correction).toContainText('Corrected source notes');
	await expect(correction).toContainText('Original source notes');
	await expect(correction).toContainText('Local saved description');
	await expect(correction).toContainText(/950,00\sSEK/);
	await expect(correction.getByRole('option', { name: 'Update existing entry' })).toBeDisabled();
	await correction.getByLabel('Possible matching entry').selectOption(local.id);
	await correction.getByLabel('Correction action').selectOption('update');
	await expect(review.getByRole('button', { name: 'Confirm import' })).toHaveCount(0);
	await review.getByRole('button', { name: 'Update review' }).click();
	await expect(correction.getByRole('heading', { name: 'Proposed update' })).toBeVisible();
	await expect(review).toContainText('Updated existing1');
	await expect(review).toContainText('Kept existing1');
	expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
	expect((await entries(page)).find((item) => item.id === local.id)?.description).toBe('Local saved description');
	const done = await confirm(page);
	await expect(done).toContainText('Updated existing1');
	await expect(done).toContainText('Kept existing1');
	const saved = await entries(page);
	expect(saved.find((item) => item.id === local.id)).toMatchObject({
		description: 'Corrected source notes', assignedRateOrePerHour: '95000', billableAmountOre: '95000',
	});
	expect(saved.find((item) => item.id === locked.id)).toEqual(locked);
	expect(saved.filter((item) => item.description === 'Moved export row')).toHaveLength(0);

	await done.getByRole('button', { name: 'Inspect another file' }).click();
	await prepare(page, 'corrected-renamed.csv', [moved, incoming]);
	await reviewChoices(page);
	await expect(review).toContainText('Already imported2');
	await review.getByRole('button', { name: 'Confirm no changes' }).click();
	const unchanged = page.getByRole('region', { name: 'No new entries imported' });
	await expect(unchanged).toBeVisible();
	expect(await entries(page)).toEqual(saved);

	await unchanged.getByRole('button', { name: 'Inspect another file' }).click();
	await prepare(page, 'second-correction.csv', [record('Second source correction', { date: '03/12/2026' })]);
	await reviewChoices(page);
	await correction.getByLabel('Possible matching entry').selectOption(local.id);
	await correction.getByLabel('Correction action').selectOption('update');
	await review.getByRole('button', { name: 'Update review' }).click();
	await expect(correction.getByRole('heading', { name: 'Proposed update' })).toBeVisible();
	const compared = correction.locator('section').filter({ has: page.getByRole('heading', { name: 'Compared Clockify row' }) });
	await expect(compared).toContainText('Corrected source notes');
	await expect(compared).not.toContainText('Original source notes');
	expect(await entries(page)).toEqual(saved);
});
