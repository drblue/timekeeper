import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
	authSessionPath, bulkEntryCommitPath, bulkEntryPreviewPath, csrfHeader, entriesPath, idempotencyKeyHeader,
	parseAuthSessionResponse, parseEntryResponse, parseEntryTrashResponse, entryTrashPath,
} from '@timekeeper/contracts';

async function signIn(page: Page) {
	await page.goto('/login');
	await page.getByLabel('Email address').fill('operator@example.test');
	await page.getByLabel('Password', { exact: true }).fill('Browser test initial password');
	await page.getByRole('button', { name: 'Sign in' }).click();
	await page.getByRole('link', { name: 'Entries', exact: true }).waitFor();
	const session = parseAuthSessionResponse(await (await page.request.get(authSessionPath)).json());
	return { Origin: new URL(page.url()).origin, [csrfHeader]: session.csrfToken };
}

const billing = { projectId: null, directClientId: null, rateOverrideOrePerHour: '80000', billable: true };

async function durationEntry(page: Page, headers: Record<string, string>, description: string, localDate: string) {
	const response = await page.request.post(entriesPath, {
		headers, data: { ...billing, kind: 'duration-only', localDate, durationSeconds: 1_800, description },
	});
	expect(response.status()).toBe(201);
	return parseEntryResponse(await response.json());
}

test('keeps one selection across allocated rows and pages and previews all matching work', async ({ page }) => {
	const headers = await signIn(page);
	const response = await page.request.post(entriesPath, {
		headers, data: {
			...billing, kind: 'timed', description: 'Bulk September overnight', startLocal: '2026-09-25T23:30:00',
			endLocal: '2026-09-26T00:15:00',
		},
	});
	expect(response.status()).toBe(201);
	const overnight = parseEntryResponse(await response.json());
	const ordinary = [];
	for (let index = 1; index <= 25; index += 1) {
		ordinary.push(await durationEntry(page, headers, 'Bulk September work ' + index, '2026-09-24'));
	}
	const url = '/entries?preset=custom&from=2026-09-24&to=2026-09-26&description=Bulk+September';
	await page.goto(url);
	const select = page.getByRole('button', { name: 'Select entries', exact: true });
	await expect(select).toBeEnabled();
	await select.focus();
	await expect(select).toBeFocused();
	await page.keyboard.press('Enter');
	const bulk = page.getByRole('region', { name: 'Select time entries' });
	await expect(bulk.getByRole('heading', { name: 'Select time entries' })).toBeFocused();
	const portions = page.getByRole('checkbox', { name: /Select Bulk September overnight/ });
	await expect(portions).toHaveCount(2);
	await portions.first().press('Space');
	await expect(portions.last()).toBeChecked();
	await expect(bulk.getByText('1 entry selected.')).toBeVisible();
	await page.getByRole('button', { name: 'Next page' }).click();
	await expect(page.getByText('Page 2 of 2')).toBeVisible();
	await expect(bulk.getByText('1 entry selected.')).toBeVisible();
	await bulk.getByRole('button', { name: 'Select all matching' }).click();
	await bulk.getByLabel('Invoice number (optional)').fill('000014');
	await bulk.getByLabel('Invoice date (optional)').fill('2026-10-02');
	await bulk.getByLabel('Invoice reference (optional)').fill('September work');
	await bulk.getByRole('button', { name: 'Review selection' }).click();
	await expect(bulk.getByRole('heading', { name: 'Mark as invoiced' })).toBeFocused();
	const totals = bulk.getByLabel('Selected whole entry totals');
	await expect(totals).toContainText('26');
	await expect(totals).toContainText('13 h 15 min');
	await expect(totals).toContainText(/10\s600,00\sSEK/);
	await expect(bulk.getByLabel('Invoice details for the selection')).toContainText('000014');
	await expect(bulk.getByLabel('Invoice details for the selection')).toContainText('2026-10-02');
	await expect(bulk.getByLabel('Invoice details for the selection')).toContainText('September work');
	await bulk.getByRole('button', { name: 'Edit selection' }).click();
	await expect(bulk.getByLabel('Invoice number (optional)')).toHaveValue('000014');
	await bulk.getByRole('button', { name: 'Review selection' }).click();
	await bulk.getByRole('button', { name: 'Confirm mark as invoiced' }).click();
	await expect(page.getByText('26 entries marked as invoiced.')).toBeVisible();
	const marked = async (id: string) => parseEntryResponse(await (await page.request.get(entriesPath + '/' + id)).json());
	expect((await marked(overnight.id)).invoiceNumber).toBe('000014');
	expect((await marked(ordinary.at(-1)!.id)).invoiceNumber).toBe('000014');
	expect(new URL(page.url()).searchParams.get('page')).toBe('2');
	expect(new URL(page.url()).searchParams.get('description')).toBe('Bulk September');
	expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
});

test('blocks partial-date and mixed invoice selections, renews stale review and retries a lost receipt', async ({ page }) => {
	const headers = await signIn(page);
	const response = await page.request.post(entriesPath, {
		headers, data: {
			...billing, kind: 'timed', description: 'Bulk October overnight', startLocal: '2026-10-25T23:30:00',
			endLocal: '2026-10-26T00:15:00',
		},
	});
	expect(response.status()).toBe(201);
	const overnight = parseEntryResponse(await response.json());
	const other = await durationEntry(page, headers, 'Bulk October work', '2026-10-26');
	const url = '/entries?preset=custom&from=2026-10-26&to=2026-10-26&description=Bulk+October';
	await page.goto(url);
	const select = page.getByRole('button', { name: 'Select entries', exact: true });
	const bulk = page.getByRole('region', { name: 'Select time entries' });
	await select.click();
	await bulk.getByRole('button', { name: 'Select all matching' }).click();
	await bulk.getByRole('button', { name: 'Review selection' }).click();
	await expect(bulk.getByText(/Part of the entry is outside the selected dates/)).toBeVisible();
	await expect(bulk.getByRole('button', { name: 'Confirm mark as invoiced' })).toHaveCount(0);
	await bulk.getByRole('button', { name: 'Cancel selection' }).press('Enter');
	await expect(select).toBeFocused();

	await select.click();
	await page.getByRole('checkbox', { name: /Select Bulk October work/ }).check();
	await bulk.getByLabel('Invoice number (optional)').fill('INV-14');
	await bulk.getByRole('button', { name: 'Review selection' }).click();
	const detail = entriesPath + '/' + other.id;
	const edited = await page.request.put(detail, { headers, data: {
		revision: other.revision, projectId: null, directClientId: null, description: 'Bulk October work revised', billable: true,
	} });
	expect(edited.status()).toBe(200);
	await bulk.getByRole('button', { name: 'Confirm mark as invoiced' }).click();
	await expect(bulk.getByText(/The selected work changed/)).toBeVisible();
	await expect(bulk.getByRole('button', { name: 'Confirm mark as invoiced' })).toHaveCount(0);
	await bulk.getByRole('button', { name: 'Review again' }).click();
	await expect(bulk.getByLabel('Invoice number (optional)')).toHaveValue('INV-14');
	await bulk.getByRole('button', { name: 'Review selection' }).click();

	const requests: { key: string | undefined; body: unknown }[] = [];
	await page.route(bulkEntryCommitPath, async (route) => {
		requests.push({ key: route.request().headers()[idempotencyKeyHeader], body: route.request().postDataJSON() });
		if (requests.length > 1) return route.continue();
		const saved = await route.fetch();
		expect(saved.status()).toBe(200);
		await route.abort();
	});
	await bulk.getByRole('button', { name: 'Confirm mark as invoiced' }).click();
	await expect(page.getByText(/Could not confirm the bulk action/)).toBeVisible();
	await page.reload();
	const retry = page.getByRole('region', { name: 'Check bulk action' });
	await retry.getByRole('button', { name: 'Retry confirmation' }).click();
	await expect(page.getByText('1 entry marked as invoiced.')).toBeVisible();
	expect(requests[0]?.key).toBeTruthy();
	expect(requests).toEqual([requests[0], requests[0]]);
	expect(parseEntryResponse(await (await page.request.get(detail)).json()).revision).toBe(other.revision + 2);

	await select.click();
	await bulk.getByRole('button', { name: 'Select all matching' }).click();
	await bulk.getByLabel('Bulk action', { exact: true }).selectOption('delete');
	await bulk.getByRole('button', { name: 'Review selection' }).click();
	await expect(bulk.getByText(/Unmark the invoice before moving/)).toBeVisible();
	await expect(bulk.getByRole('button', { name: 'Confirm move to trash' })).toHaveCount(0);
	expect((await page.request.get(entriesPath + '/' + overnight.id)).status()).toBe(200);
	await bulk.getByRole('button', { name: 'Cancel selection' }).click();

	await select.click();
	await page.getByRole('checkbox', { name: /Select Bulk October work/ }).check();
	await bulk.getByLabel('Bulk action', { exact: true }).selectOption('unmark-invoiced');
	await bulk.getByRole('button', { name: 'Review selection' }).click();
	await bulk.getByRole('button', { name: 'Confirm unmark invoice' }).click();
	await expect(page.getByText('1 entry unmarked.')).toBeVisible();
	await select.click();
	await bulk.getByRole('button', { name: 'Select all matching' }).click();
	await bulk.getByLabel('Bulk action', { exact: true }).selectOption('delete');
	await bulk.getByRole('button', { name: 'Review selection' }).click();
	await bulk.getByRole('button', { name: 'Confirm move to trash' }).click();
	await expect(page.getByText('2 entries moved to Trash.')).toBeVisible();
	await expect(page.getByText('No completed time entries match these filters.')).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Time entries', exact: true })).toBeFocused();
	expect(parseEntryTrashResponse(await (await page.request.get(entryTrashPath)).json()).map(({ entry }) => entry.id))
		.toEqual(expect.arrayContaining([overnight.id, other.id]));
	expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
});

test('discards a preview received after the matching filters change', async ({ page }) => {
	const headers = await signIn(page);
	await durationEntry(page, headers, 'Delayed bulk preview', '2026-10-30');
	await page.goto('/entries?preset=custom&from=2026-10-30&to=2026-10-30');
	const select = page.getByRole('button', { name: 'Select entries', exact: true });
	const bulk = page.getByRole('region', { name: 'Select time entries' });
	await select.click();
	await bulk.getByRole('button', { name: 'Select all matching' }).click();

	let requestSent!: () => void;
	let releasePreview!: () => void;
	const sent = new Promise<void>((resolve) => { requestSent = resolve; });
	const release = new Promise<void>((resolve) => { releasePreview = resolve; });
	await page.route(bulkEntryPreviewPath, async (route) => {
		requestSent();
		await release;
		await route.continue();
	});
	await bulk.getByRole('button', { name: 'Review selection' }).click();
	await sent;
	await page.getByRole('button', { name: 'Filters', exact: true }).click();
	await page.getByLabel('Search description').fill('does not exist');
	await page.getByRole('button', { name: 'Apply filters' }).click();
	await expect(page.getByText('No completed time entries match these filters.')).toBeVisible();
	const previewResponse = page.waitForResponse((response) => response.url().endsWith(bulkEntryPreviewPath));
	releasePreview();
	expect((await previewResponse).status()).toBe(200);
	await expect(select).toBeDisabled();
	await expect(bulk).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Confirm mark as invoiced' })).toHaveCount(0);
});

test('reviews an overnight split, preserves one öre, and links both portions to the original', async ({ page }) => {
	const headers = await signIn(page);
	const response = await page.request.post(entriesPath, {
		headers, data: {
			...billing, kind: 'timed', description: 'Split December one öre', startLocal: '2026-12-08T23:30:00',
			endLocal: '2026-12-09T00:30:00', rateOverrideOrePerHour: '1',
		},
	});
	expect(response.status()).toBe(201);
	const original = parseEntryResponse(await response.json());
	const detail = entriesPath + '/' + original.id;
	await page.goto('/entries?preset=custom&from=2026-12-09&to=2026-12-09&description=Split+December');
	const select = page.getByRole('button', { name: 'Select entries', exact: true });
	const bulk = page.getByRole('region', { name: 'Select time entries' });
	async function reviewSplit() {
		await select.click();
		await page.getByRole('checkbox', { name: /Select Split December/ }).check();
		await bulk.getByLabel('Invoice number (optional)').fill('000015');
		await bulk.getByRole('button', { name: 'Review selection' }).click();
		await expect(bulk.getByRole('button', { name: 'Confirm mark as invoiced' })).toHaveCount(0);
		const review = bulk.getByRole('button', { name: 'Review split and mark' });
		await expect(review).toBeEnabled();
		await review.press('Enter');
		await expect(bulk.getByRole('heading', { name: 'Split and mark as invoiced' })).toBeFocused();
	}
	await reviewSplit();
	const totals = bulk.getByLabel('Work to be marked as invoiced');
	await expect(totals).toContainText(/30 min/);
	await expect(totals).toContainText(/0,00\sSEK/);
	await expect(bulk.getByLabel('Selected whole entry totals')).toContainText(/0,01\sSEK/);
	const inside = bulk.getByRole('listitem').filter({ has: page.getByText('Mark as invoiced', { exact: true }) });
	const outside = bulk.getByRole('listitem').filter({ has: page.getByText('Keep uninvoiced', { exact: true }) });
	await expect(inside).toContainText(/2026-12-09 00:00.*2026-12-09 00:30/);
	await expect(inside).toContainText(/0,00\sSEK/);
	await expect(outside).toContainText(/2026-12-08 23:30.*2026-12-09 00:00/);
	await expect(outside).toContainText(/0,01\sSEK/);
	await expect(bulk.getByLabel('Invoice details for the selection')).toContainText('000015');
	expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
	await bulk.getByRole('button', { name: 'Cancel selection' }).click();
	await expect(select).toBeFocused();
	expect(parseEntryResponse(await (await page.request.get(detail)).json())).toEqual(original);

	await reviewSplit();
	const changed = await page.request.put(detail, { headers, data: {
		revision: original.revision, projectId: null, directClientId: null,
		description: 'Split December one öre revised', billable: true,
	} });
	expect(changed.status()).toBe(200);
	await bulk.getByRole('button', { name: 'Confirm split and mark' }).click();
	await expect(bulk.getByText(/The selected work changed/)).toBeVisible();
	expect(parseEntryResponse(await (await page.request.get(detail)).json()).supersededAt).toBeUndefined();
	await bulk.getByRole('button', { name: 'Review again' }).click();
	await expect(bulk.getByLabel('Invoice number (optional)')).toHaveValue('000015');
	await bulk.getByRole('button', { name: 'Review selection' }).click();
	await bulk.getByRole('button', { name: 'Review split and mark' }).click();

	const commits: { key: string | undefined; body: unknown }[] = [];
	await page.route(bulkEntryCommitPath, async (route) => {
		commits.push({ key: route.request().headers()[idempotencyKeyHeader], body: route.request().postDataJSON() });
		if (commits.length > 1) return route.continue();
		expect((await route.fetch()).status()).toBe(200);
		await route.abort();
	});
	await bulk.getByRole('button', { name: 'Confirm split and mark' }).click();
	await expect(page.getByText(/Could not confirm the bulk action/)).toBeVisible();
	await page.reload();
	const retry = page.getByRole('region', { name: 'Check bulk action' });
	await expect(retry.getByText(/Split and mark as invoiced/)).toBeVisible();
	await retry.getByRole('button', { name: 'Retry confirmation' }).click();
	await expect(page.getByText('1 entry split. Work within the selected dates marked as invoiced.')).toBeVisible();
	expect(commits[0]?.key).toBeTruthy();
	expect(commits).toEqual([commits[0], commits[0]]);

	const savedOriginal = parseEntryResponse(await (await page.request.get(detail)).json());
	expect(savedOriginal.supersededAt).toBeTruthy();
	expect(savedOriginal.splitChildEntryIds).toHaveLength(2);
	const matchingChild = page.getByRole('link', { name: 'Split December one öre revised' });
	await expect(page.getByRole('article').filter({ has: matchingChild })).toContainText('Invoiced · 000015');
	await matchingChild.click();
	await page.getByRole('button', { name: 'Show history' }).click();
	await expect(page.getByRole('heading', { name: 'Created from split' })).toBeVisible();
	await page.getByRole('link', { name: 'View original entry' }).click();
	await expect(page.getByRole('heading', { name: 'Split original' })).toBeVisible();
	await expect(page.getByRole('button', { name: /^(Edit entry|Continue|Move to Trash|Mark as invoiced)/ })).toHaveCount(0);
	await page.getByRole('button', { name: 'Show history' }).click();
	await expect(page.getByRole('heading', { name: 'Split for invoicing' })).toBeVisible();
	await page.getByRole('link', { name: 'View portion 1' }).click();
	await expect(page.getByRole('region', { name: 'Invoice', exact: true })).toContainText('Not yet invoiced');
	await expect(page.getByText('0,01 SEK', { exact: true })).toBeVisible();
});
