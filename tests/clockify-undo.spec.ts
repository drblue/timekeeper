import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { authSessionPath, clockifyBatchesPath, csrfHeader, entriesPath, idempotencyKeyHeader, parseAuthSessionResponse, parseEntryListResponse } from '@timekeeper/contracts';
import { file, headers, record, signIn } from './clockify-fixture.js';

async function reviewFile(page: Page, name: string, rows: string[], configure = true) {
	await page.getByLabel('Clockify CSV file').setInputFiles(file(name, [headers.join(','), ...rows]));
	await page.getByRole('button', { name: 'Inspect file' }).click();
	await page.getByRole('button', { name: 'Prepare import', exact: true }).click();
	if (configure) {
		const mapping = page.getByRole('group', { name: 'A client · A project' });
		await mapping.getByLabel('Client', { exact: true }).selectOption('none');
		await mapping.getByLabel('Project', { exact: true }).selectOption('none');
		const billing = page.getByRole('group', { name: 'Default historical billing' });
		await billing.getByLabel('Billing', { exact: true }).selectOption('billable');
		await billing.getByLabel('Historical hourly rate (SEK)').fill('800');
	}
	await page.getByRole('button', { name: 'Review import choices' }).click();
	return page.getByRole('region', { name: 'Review import' });
}

async function entries(page: Page) {
	return parseEntryListResponse(await (await page.request.get(entriesPath)).json());
}

test('reviews, cancels, safely retries and records a mixed import undo', async ({ page }) => {
	await signIn(page);
	await page.goto('/entries?description=guarded');
	await page.getByRole('link', { name: 'Import Clockify CSV' }).click();
	await page.getByRole('link', { name: 'Import history' }).click();
	await expect(page.getByText('No Clockify imports yet.')).toBeVisible();
	await page.getByRole('link', { name: 'Inspect a Clockify export' }).click();

	const original = record('Guarded original work');
	const corrected = record('Guarded corrected work', { start: '10:00:00', end: '11:00:00' });
	const invoiced = record('Imported with invoice status', { date: '26/10/2026', tags: 'Invoiced' });
	const done = page.getByRole('region', { name: 'Import complete' });
	let review = await reviewFile(page, 'original.csv', [original]);
	await review.getByRole('button', { name: 'Confirm import', exact: true }).click();
	await done.getByRole('button', { name: 'Inspect another file' }).click();
	const initial = (await entries(page)).find((entry) => entry.description === 'Guarded original work')!;
	expect(initial).toBeTruthy();

	review = await reviewFile(page, 'corrected.csv', [corrected, invoiced]);
	await review.getByRole('button', { name: 'Edit import choices' }).click();
	const row = page.getByRole('region', { name: 'Row choices' }).getByRole('listitem').filter({ hasText: 'Guarded corrected work' });
	await row.getByRole('strong').filter({ hasText: 'Guarded corrected work' }).click();
	await row.getByText('Match to previously imported work', { exact: true }).click();
	await row.getByText('Find another imported entry', { exact: true }).click();
	await row.getByRole('searchbox', { name: 'Search imported entries' }).fill('Guarded original work');
	await row.getByRole('button', { name: 'Search imported entries', exact: true }).click();
	await row.getByRole('button', { name: /Choose Guarded original work/ }).click();
	await row.getByLabel('Correction action').selectOption('update');
	await page.getByRole('button', { name: 'Review import choices' }).click();
	await review.getByRole('button', { name: 'Confirm import', exact: true }).click();
	await expect(done).toContainText('Updated existing1');
	const beforeUndo = await entries(page);
	expect(beforeUndo.find((entry) => entry.description === 'Imported with invoice status')?.invoicedAt).toBeTruthy();

	await page.getByRole('link', { name: 'Import history' }).click();
	const latest = page.getByRole('article').filter({ hasText: 'Updated' });
	const latestUndo = latest.getByRole('button', { name: 'Review undo' });
	await latestUndo.click();
	const undo = page.getByRole('region', { name: 'Review import undo' });
	await expect(undo.getByRole('heading')).toBeFocused();
	await expect(undo).toContainText('Move to Trash1');
	await expect(undo).toContainText('Revert updates1');
	await expect(undo).toContainText('Guarded original work');
	await expect(undo).toContainText('Guarded corrected work');
	const shifted = undo.getByRole('listitem').filter({ hasText: 'Guarded corrected work' });
	await expect(shifted).toContainText(/10:00 \(UTC\+01:00\) to 2026-10-25 11:00/);
	await expect(shifted).toContainText(/09:00 \(UTC\+01:00\) to 2026-10-25 10:00/);
	await expect(undo).toContainText('Imported with invoice status');
	await expect(undo.getByRole('button', { name: 'Confirm undo' })).toBeEnabled();
	expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
	await undo.getByRole('button', { name: 'Cancel undo' }).click();
	await expect(latestUndo).toBeFocused();
	expect(await entries(page)).toEqual(beforeUndo);

	const undoRequests: { key?: string; body: unknown }[] = [];
	await page.route('**' + clockifyBatchesPath + '/*/undo', async (route) => {
		const request = route.request();
		undoRequests.push({ key: request.headers()[idempotencyKeyHeader], body: request.postDataJSON() });
		if (undoRequests.length === 1) {
			const response = await route.fetch();
			expect(response.status()).toBe(200);
			await route.abort();
		} else {
			await route.continue();
		}
	});
	await latestUndo.click();
	await undo.getByRole('button', { name: 'Confirm undo' }).click();
	await expect(page.getByRole('alert')).toContainText('Could not confirm whether the undo finished');
	await page.reload();
	const retry = page.getByRole('button', { name: 'Retry undo' });
	await expect(retry).toBeFocused();
	await retry.click();
	await expect(page.getByRole('status').filter({ hasText: 'Import undone.' })).toContainText('Moved to Trash: 1. Reverted: 1.');
	expect(undoRequests).toHaveLength(2);
	expect(undoRequests[0]?.key).toBeTruthy();
	expect(undoRequests[1]).toEqual(undoRequests[0]);
	await expect(latest).toContainText('Undone');
	await expect(latestUndo).toHaveCount(0);
	const after = await entries(page);
	expect(after.find((entry) => entry.id === initial.id)).toMatchObject({
		description: initial.description, billableAmountOre: initial.billableAmountOre,
	});
	expect(after.some((entry) => entry.description === 'Imported with invoice status')).toBe(false);
	await page.getByRole('link', { name: 'View Trash' }).click();
	const trashed = page.getByRole('article').filter({ hasText: 'Imported with invoice status' });
	await expect(trashed).toContainText('Invoiced');
	await expect(trashed.getByRole('button', { name: 'Restore Imported with invoice status' })).toBeEnabled();
	await page.goBack();

	await page.getByRole('link', { name: 'Inspect a Clockify export' }).click();
	review = await reviewFile(page, 'repeat-original.csv', [original], false);
	await review.getByRole('button', { name: 'Confirm no changes' }).click();
	await expect(page.getByRole('region', { name: 'No new entries imported' })).toContainText('Already imported1');
	await page.getByRole('link', { name: 'Import history' }).click();
	await expect(page.getByRole('article').filter({ hasText: 'Already imported' })).toHaveCount(0);

	const restored = after.find((entry) => entry.id === initial.id)!;
	const session = parseAuthSessionResponse(await (await page.request.get(authSessionPath)).json());
	const edit = await page.request.put(entriesPath + '/' + initial.id, {
		headers: { Origin: new URL(page.url()).origin, [csrfHeader]: session.csrfToken },
		data: { revision: restored.revision, description: 'Later local edit', projectId: null, directClientId: null, billable: true },
	});
	expect(edit.status()).toBe(200);
	await page.getByRole('button', { name: 'Review undo' }).click();
	await expect(undo).toContainText('This entry was changed after import.');
	await expect(undo.getByRole('button', { name: 'Confirm undo' })).toHaveCount(0);
	await undo.getByRole('button', { name: 'Back to import history' }).click();
	await page.getByRole('link', { name: 'Back to time entries' }).click();
	await expect(page).toHaveURL(/description=guarded/);
	await expect(page.getByRole('link', { name: 'Import Clockify CSV' })).toBeFocused();

	await page.getByRole('link', { name: 'Import Clockify CSV' }).click();
	review = await reviewFile(page, 'reimport-invoiced.csv', [invoiced]);
	await expect(review).toContainText('New entries1');
	await review.getByRole('button', { name: 'Confirm import', exact: true }).click();
	await expect(done).toContainText('Invoiced1');
	const reimported = await entries(page);
	await page.goto('/entries/trash');
	await trashed.getByRole('button', { name: 'Restore Imported with invoice status' }).click();
	await expect(page.getByRole('alert')).toContainText('This Clockify occurrence has already been reimported.');
	expect(await entries(page)).toEqual(reimported);
});
