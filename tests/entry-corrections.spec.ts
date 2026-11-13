import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
	authSessionPath, clientsPath, csrfHeader, entriesPath, parseAuthSessionResponse, parseClientResponse,
	parseEntryHistoryResponse, parseEntryResponse,
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

test('previews timing conversions and rate choices before saving, then shows history', async ({ page }) => {
	const headers = await signIn(page);
	const source = parseClientResponse(await (await page.request.post(clientsPath, {
		headers, data: { name: 'Original correction client', defaultRateOrePerHour: '80000', notes: null },
	})).json());
	const destination = parseClientResponse(await (await page.request.post(clientsPath, {
		headers, data: { name: 'New correction client', defaultRateOrePerHour: '90000', notes: null },
	})).json());
	const original = parseEntryResponse(await (await page.request.post(entriesPath, {
		headers, data: {
			kind: 'duration-only', localDate: '2026-10-19', durationSeconds: 1800,
			description: 'Correct original work', projectId: null, directClientId: source.id, rateOverrideOrePerHour: null,
		},
	})).json());
	const path = entriesPath + '/' + original.id;
	await page.goto('/entries/' + original.id);
	const edit = page.getByRole('button', { name: 'Edit entry' });
	const description = page.getByLabel('Description', { exact: true });
	const preview = page.getByRole('button', { name: 'Preview changes' });
	const save = page.getByRole('button', { name: 'Save changes', exact: true });
	await edit.click();
	await expect(description).toBeFocused();
	await expect(description).toHaveValue(original.description);
	await page.getByLabel('Association', { exact: true }).selectOption({ label: destination.name });
	const rate = page.getByLabel('Hourly rate', { exact: true });
	await expect(rate).toHaveValue('keep');
	await expect(rate.locator('option:checked')).toContainText('800,00 SEK');
	await page.getByRole('radio', { name: 'Timed', exact: true }).check();
	const start = page.getByLabel('Start time', { exact: true });
	const end = page.getByLabel('End time', { exact: true });
	await expect(start).toHaveValue('');
	await expect(end).toHaveValue('');
	await preview.click();
	await expect(start).toBeFocused();
	await expect(start).toHaveAccessibleDescription(/Enter a time/);
	await start.fill('2330');
	await page.getByLabel('End date', { exact: true }).fill('2026-10-20');
	await end.fill('0015');
	await preview.click();
	await expect(page.getByRole('heading', { name: 'Review changes' })).toBeFocused();
	await expect(page.getByText('00:30:00 → 00:45:00')).toBeVisible();
	await expect(page.getByText(/400,00\sSEK → 600,00\sSEK/)).toBeVisible();
	expect(parseEntryResponse(await (await page.request.get(path)).json())).toEqual(original);
	await description.fill('Corrected timed work');
	await expect(save).toHaveCount(0);
	await preview.click();
	await save.click();
	await expect(page.getByRole('heading', { name: 'Corrected timed work' })).toBeVisible();
	const timed = parseEntryResponse(await (await page.request.get(path)).json());
	expect(timed).toMatchObject({
		kind: 'timed', durationSeconds: 2700, directClientId: destination.id,
		assignedRateOrePerHour: '80000', billableAmountOre: '60000',
		startAt: '2026-10-19T21:30:00.000Z', endAt: '2026-10-19T22:15:00.000Z',
	});

	await edit.click();
	await page.getByRole('radio', { name: 'Duration only', exact: true }).check();
	await expect(page.getByLabel('Duration', { exact: true })).toHaveValue('00:45:00');
	await rate.selectOption('current');
	await preview.click();
	await expect(page.getByText(/600,00\sSEK → 675,00\sSEK/)).toBeVisible();
	await save.click();
	await expect(page.getByText('Time entry updated.')).toBeVisible();
	const converted = parseEntryResponse(await (await page.request.get(path)).json());
	expect(converted).toMatchObject({ kind: 'duration-only', durationSeconds: 2700, billableAmountOre: '67500', assignedRateOrePerHour: '90000' });
	expect(converted).not.toHaveProperty('startAt');

	await page.getByRole('button', { name: 'Show history' }).click();
	const history = page.getByRole('region', { name: 'History' });
	await expect(history.getByRole('heading', { name: 'Edited', exact: true })).toHaveCount(2);
	await expect(history.getByText('Before: Correct original work')).toBeVisible();
	await expect(history.getByText('After: Corrected timed work')).toBeVisible();
	await expect(history.getByText(/After: 900,00\sSEK\/hour/)).toBeVisible();
	expect(await history.locator('time[datetime]').count()).toBeGreaterThanOrEqual(2);
	const duplicate = parseClientResponse(await (await page.request.post(clientsPath, {
		headers, data: { name: destination.name, defaultRateOrePerHour: '90000', notes: null, confirmDuplicate: true },
	})).json());
	const reassigned = await page.request.put(path, {
		headers, data: {
			revision: converted.revision, description: converted.description,
			projectId: null, directClientId: duplicate.id, billable: true,
		},
	});
	expect(reassigned.ok()).toBe(true);
	await page.reload();
	await page.getByRole('button', { name: 'Show history' }).click();
	await expect(history.getByText(`Before: ${destination.name} (${destination.id})`, { exact: true })).toBeVisible();
	await expect(history.getByText(`After: ${duplicate.name} (${duplicate.id})`, { exact: true })).toBeVisible();
	expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
});

test('preserves unchanged DST timing and keeps a stale draft available for explicit review', async ({ page }) => {
	const headers = await signIn(page);
	const original = parseEntryResponse(await (await page.request.post(entriesPath, {
		headers, data: {
			kind: 'timed', startLocal: '2026-10-25T02:00:01', endLocal: '2026-10-25T02:15:02',
			startOccurrence: 'earlier', endOccurrence: 'later',
			description: 'Repeated hour work', projectId: null, directClientId: null, rateOverrideOrePerHour: null,
		},
	})).json());
	const path = entriesPath + '/' + original.id;
	await page.goto('/entries/' + original.id);
	await page.getByRole('button', { name: 'Edit entry' }).click();
	await expect(page.getByLabel('Start time', { exact: true })).toHaveValue('02:00:01');
	await expect(page.getByLabel('Start time occurrence')).toHaveValue('earlier');
	await expect(page.getByLabel('End time occurrence')).toHaveValue('later');
	const draft = page.getByLabel('Description', { exact: true });
	await draft.fill('Draft kept after conflict');
	const remote = await page.request.put(path, {
		headers, data: {
			revision: original.revision, description: 'Remote revision', projectId: null, directClientId: null, billable: false,
		},
	});
	expect(remote.ok()).toBe(true);

	const preview = page.getByRole('button', { name: 'Preview changes' });
	await preview.click();
	await expect(page.getByRole('alert')).toContainText('This entry changed in another session');
	await expect(draft).toHaveValue('Draft kept after conflict');
	await expect(preview).toBeDisabled();
	await page.getByRole('button', { name: 'Review latest entry' }).click();
	await expect(page.getByRole('heading', { name: 'Latest saved entry' })).toBeFocused();
	await expect(page.getByText('Remote revision', { exact: true })).toBeVisible();
	await expect(draft).toHaveValue('Draft kept after conflict');
	await page.getByRole('button', { name: 'Keep draft for review' }).click();
	const request = page.waitForRequest((item) => item.method() === 'POST' && new URL(item.url()).pathname === path + '/edit-preview');
	await preview.click();
	expect((await request).postDataJSON()).not.toHaveProperty('time');
	await page.getByRole('button', { name: 'Save changes', exact: true }).click();
	await expect(page.getByText('Time entry updated.')).toBeVisible();
	const updated = parseEntryResponse(await (await page.request.get(path)).json());
	expect(updated).toMatchObject({ description: 'Draft kept after conflict', kind: 'timed', durationSeconds: original.durationSeconds });
	if (original.kind !== 'timed' || updated.kind !== 'timed') throw new Error('Expected timed entries');
	expect(updated.startAt).toBe(original.startAt);
	expect(updated.endAt).toBe(original.endAt);
	const history = parseEntryHistoryResponse(await (await page.request.get(path + '/history')).json());
	expect(history.slice(0, 2).map((row) => row.after.description)).toEqual(['Draft kept after conflict', 'Remote revision']);
});

test('displays the invoice lock while leaving prior work available to continue', async ({ page }) => {
	const headers = await signIn(page);
	const original = parseEntryResponse(await (await page.request.post(entriesPath, {
		headers, data: {
			kind: 'duration-only', localDate: '2026-10-19', durationSeconds: 1800,
			description: 'Invoiced work', projectId: null, directClientId: null, rateOverrideOrePerHour: '80000', billable: true,
		},
	})).json());
	await page.route('**' + entriesPath + '/' + original.id, (route) => route.fulfill({
		json: { ...original, invoicedAt: '2026-10-20T09:00:00.000Z' },
	}));
	await page.goto('/entries/' + original.id);
	await expect(page.getByText('This entry is invoiced. Unmark it before editing.')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Edit entry' })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Continue work' })).toBeEnabled();
	await expect(page.getByRole('button', { name: 'Show history' })).toBeEnabled();
});
