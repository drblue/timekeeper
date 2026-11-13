import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
	authSessionPath, csrfHeader, entriesPath, entryTrashPath, parseAuthSessionResponse, parseEntryHistoryResponse,
	parseEntryResponse, parseEntryTrashResponse, parseTrashedEntryResponse,
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

test('confirms moving to Trash, preserves list scope, and restores the original entry and history', async ({ page }) => {
	const headers = await signIn(page);
	const response = await page.request.post(entriesPath, {
		headers,
		data: {
			kind: 'timed', description: 'Archive this overnight work', startLocal: '2026-09-23T23:30:00',
			endLocal: '2026-09-24T00:15:00', projectId: null, directClientId: null, rateOverrideOrePerHour: '80000',
			billable: true,
		},
	});
	expect(response.ok()).toBe(true);
	const entry = parseEntryResponse(await response.json());
	const detail = entriesPath + '/' + entry.id;
	await page.goto('/entries?preset=custom&from=2026-09-24&to=2026-09-24&description=overnight&sort=oldest');
	await page.getByRole('link', { name: entry.description }).click();

	let deletes = 0;
	page.on('request', (request) => {
		if (new URL(request.url()).pathname === detail + '/delete') deletes++;
	});
	const move = page.getByRole('button', { name: 'Move to Trash', exact: true });
	await move.click();
	await expect(page.getByRole('heading', { name: 'Move this entry to Trash?' })).toBeFocused();
	await page.getByRole('button', { name: 'Cancel', exact: true }).press('Enter');
	await expect(move).toBeFocused();
	expect(deletes).toBe(0);
	expect((await page.request.get(detail)).status()).toBe(200);

	await move.press('Enter');
	const deleted = page.waitForResponse((result) => new URL(result.url()).pathname === detail + '/delete' && result.ok());
	await move.click();
	const trashed = parseTrashedEntryResponse(await (await deleted).json());
	await expect(page.getByText('Time entry moved to Trash.')).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Completed work' })).toBeFocused();
	expect(deletes).toBe(1);
	expect(new URL(page.url()).searchParams.get('description')).toBe('overnight');
	expect(new URL(page.url()).searchParams.get('sort')).toBe('oldest');
	await expect(page.getByLabel('Totals for all matching days')).toContainText('0 s');
	await expect(page.getByRole('link', { name: entry.description })).toHaveCount(0);
	expect((await page.request.get(detail)).status()).toBe(404);

	await page.getByRole('link', { name: 'Trash', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'Trash', exact: true })).toBeVisible();
	await page.reload();
	const row = page.getByRole('article').filter({ hasText: entry.description });
	await expect(row).toContainText('45 min');
	await expect(row.locator('time[datetime="' + trashed.restoreUntil + '"]')).toBeVisible();
	expect(Date.parse(trashed.restoreUntil) - Date.parse(trashed.deletedAt)).toBe(30 * 86_400_000);
	await row.getByRole('button', { name: 'Restore ' + entry.description }).click();
	await expect(page.getByText('Time entry restored.')).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Trash', exact: true })).toBeFocused();
	await expect(row).toHaveCount(0);
	await page.getByRole('link', { name: 'View restored entry' }).click();
	const restored = parseEntryResponse(await (await page.request.get(detail)).json());
	expect(restored).toEqual({ ...entry, revision: entry.revision + 2 });
	await page.getByRole('button', { name: 'Show history' }).click();
	const history = page.getByRole('region', { name: 'History' });
	await expect(history.getByRole('heading', { name: 'Moved to Trash' })).toBeVisible();
	await expect(history.getByRole('heading', { name: 'Restored' })).toBeVisible();
	const snapshots = parseEntryHistoryResponse(await (await page.request.get(detail + '/history')).json());
	expect(snapshots.map((change) => change.action)).toEqual(['restored', 'deleted', 'created']);
	await page.getByRole('link', { name: 'Back to time entries' }).click();
	await expect(page.getByRole('link', { name: entry.description })).toBeFocused();
	await expect(page.getByLabel('Totals for all matching days')).toContainText('15 min');
	expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
});

test('refreshes a stale move without deleting and reports an expired restore', async ({ page }) => {
	const headers = await signIn(page);
	const entry = parseEntryResponse(await (await page.request.post(entriesPath, {
		headers,
		data: {
			kind: 'duration-only', description: 'Review before deleting', localDate: '2026-09-23', durationSeconds: 60,
			projectId: null, directClientId: null, rateOverrideOrePerHour: null,
		},
	})).json());
	const detail = entriesPath + '/' + entry.id;
	await page.goto('/entries/' + entry.id);
	const move = page.getByRole('button', { name: 'Move to Trash', exact: true });
	await move.click();
	const edited = await page.request.put(detail, {
		headers, data: { revision: entry.revision, description: 'Updated before deletion', projectId: null, directClientId: null, billable: false },
	});
	expect(edited.ok()).toBe(true);
	await move.click();
	await expect(page.getByRole('alert')).toContainText('This entry changed in another session.');
	expect((await page.request.get(detail)).status()).toBe(200);
	await page.getByRole('button', { name: 'Check saved entry' }).click();
	await expect(page.getByRole('heading', { name: 'Updated before deletion' })).toBeVisible();
	await expect(move).toBeFocused();
	await move.click();
	await move.click();
	await page.getByRole('link', { name: 'Trash', exact: true }).click();
	const records = parseEntryTrashResponse(await (await page.request.get(entryTrashPath)).json());
	expect(records.some((record) => record.entry.id === entry.id)).toBe(true);

	await page.route('**' + detail + '/restore', async (route) => {
		await page.route('**' + entryTrashPath, (read) => read.fulfill({ json: [] }));
		await route.fulfill({ status: 409, json: { code: 'ENTRY_RESTORE_EXPIRED', message: 'Expired' } });
	});
	await page.getByRole('button', { name: 'Restore Updated before deletion' }).click();
	await expect(page.getByRole('alert')).toContainText('The restore deadline has passed.');
	await expect(page.getByText('Trash is empty.')).toBeVisible();
	await expect(page.getByText('Time entry restored.')).toHaveCount(0);
});
