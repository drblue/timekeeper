import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
	authSessionPath,
	clientsPath,
	csrfHeader,
	entriesPath,
	parseAuthSessionResponse,
	parseClientResponse,
	parseDurationEntryListResponse,
	parseDurationEntryResponse,
	parseProjectResponse,
	projectsPath,
} from '@timekeeper/contracts';

test.use({ timezoneId: 'America/Los_Angeles' });

async function openEditor(page: Page, description: string) {
	await page.getByRole('button', { name: 'New time entry', exact: true }).click();
	const field = page.getByLabel('Description', { exact: true });
	await expect(field).toBeFocused();
	await field.fill(description);
}

async function saveEntry(page: Page) {
	const saved = page.waitForResponse((response) => response.request().method() === 'POST' &&
		new URL(response.url()).pathname === entriesPath && response.status() === 201);
	await page.getByRole('button', { name: 'Save time entry' }).click();
	return parseDurationEntryResponse(await (await saved).json());
}

test('records duration-only work, snapshots defaults, and displays the exact saved amounts', async ({ page }) => {
	await page.clock.setFixedTime(new Date('2026-11-10T23:30:00.000Z'));
	expect((await page.request.get(entriesPath)).status()).toBe(401);
	await page.goto('/entries');
	await expect(page).toHaveURL(/\/login$/);
	await page.getByLabel('Email address').fill('operator@example.test');
	await page.getByLabel('Password', { exact: true }).fill('Browser test initial password');
	await page.getByRole('button', { name: 'Sign in' }).click();
	await page.getByRole('link', { name: 'Entries', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'Time entries' })).toBeVisible();

	const session = parseAuthSessionResponse(await (await page.request.get(authSessionPath)).json());
	const headers = { Origin: new URL(page.url()).origin, [csrfHeader]: session.csrfToken };
	async function post(path: string, data: object) {
		const response = await page.request.post(path, { headers, data });
		expect(response.ok()).toBe(true);
		return response.json() as Promise<unknown>;
	}
	const client = parseClientResponse(await post(clientsPath, {
		name: 'Studio', defaultRateOrePerHour: '80000', notes: null,
	}));
	const clientWithoutRate = parseClientResponse(await post(clientsPath, {
		name: 'No rate client', defaultRateOrePerHour: null, notes: null,
	}));
	const archivedClient = parseClientResponse(await post(clientsPath, {
		name: 'Archived client', defaultRateOrePerHour: '65000', notes: null,
	}));
	const project = parseProjectResponse(await post(projectsPath, {
		name: 'Editorial', clientId: client.id, rateOverrideOrePerHour: null, notes: null,
	}));
	const unavailableProject = parseProjectResponse(await post(projectsPath, {
		name: 'Unavailable project', clientId: archivedClient.id, rateOverrideOrePerHour: null, notes: null,
	}));
	await post(`${clientsPath}/${archivedClient.id}/archive`, { revision: archivedClient.revision });

	await openEditor(page, 'Draw cover concepts');
	await expect(page.getByLabel('Work date')).toHaveValue('2026-11-11');
	await page.getByLabel('Work date').fill('2026-10-19');
	const association = page.getByLabel('Association', { exact: true });
	await association.selectOption({ label: 'Editorial (Studio)' });
	await expect(association.locator('option', { hasText: 'Archived client' })).toHaveCount(0);
	await expect(association.locator('option', { hasText: unavailableProject.name })).toHaveCount(0);
	await expect(page.getByText(/Leave blank to use 800,00/)).toBeVisible();
	await expect(page.getByLabel('Billability').locator('option:checked')).toHaveText('Use default (billable)');
	await page.getByLabel('Hours', { exact: true }).fill('0');
	await page.getByLabel('Minutes', { exact: true }).fill('0');
	await page.getByRole('button', { name: 'Save time entry' }).click();
	await expect(page.getByRole('alert')).toHaveText('Enter a duration of at least one minute.');
	await page.getByLabel('Minutes', { exact: true }).fill('90');
	const first = await saveEntry(page);
	expect(first).toMatchObject({
		kind: 'duration-only',
		localDate: '2026-10-19',
		durationSeconds: 5400,
		projectId: project.id,
		directClientId: null,
		clientId: client.id,
		assignedRateOrePerHour: '80000',
		billable: true,
		billableAmountOre: '120000',
	});
	expect(first).not.toHaveProperty('startedAt');
	expect(first).not.toHaveProperty('endedAt');
	const original = page.getByRole('article').filter({ hasText: 'Draw cover concepts' });
	await expect(original).toContainText('1 h 30 min');
	await expect(original).toContainText('1 200,00 SEK');
	await original.getByRole('link').click();
	await page.reload();
	await expect(page.getByRole('heading', { name: 'Draw cover concepts' })).toBeVisible();
	await expect(page.getByText('2026-10-19', { exact: true })).toBeVisible();
	await expect(page.getByText('800,00 SEK/hour', { exact: true })).toBeVisible();

	await page.getByRole('link', { name: 'Clients', exact: true }).click();
	const studio = page.getByRole('article', { name: 'Studio', exact: true });
	await studio.getByRole('button', { name: 'Edit' }).click();
	await page.getByLabel('Default hourly rate (SEK)').fill('900');
	await page.getByRole('button', { name: 'Save changes' }).click();
	await expect(studio).toContainText('900.00 SEK/hour');

	await page.getByRole('link', { name: 'Entries', exact: true }).click();
	await openEditor(page, 'Refine cover concepts');
	await association.selectOption({ label: 'Editorial (Studio)' });
	await expect(page.getByText(/Leave blank to use 900,00/)).toBeVisible();
	await page.getByLabel('Hours', { exact: true }).fill('1');
	await page.getByLabel('Minutes', { exact: true }).fill('30');
	const second = await saveEntry(page);
	expect(second).toMatchObject({
		durationSeconds: 5400,
		projectId: project.id,
		assignedRateOrePerHour: '90000',
		billableAmountOre: '135000',
	});
	const savedEntries = parseDurationEntryListResponse(await (await page.request.get(entriesPath)).json());
	expect(savedEntries.find((entry) => entry.id === first.id)).toMatchObject({
		assignedRateOrePerHour: '80000', billableAmountOre: '120000',
	});

	await openEditor(page, 'Direct client with zero rate');
	await association.selectOption({ label: clientWithoutRate.name });
	await page.getByLabel('Minutes', { exact: true }).fill('10');
	await page.getByRole('button', { name: 'Save time entry' }).click();
	await expect(page.getByRole('alert')).toContainText('Enter an hourly rate or choose Non-billable.');
	await page.getByLabel('Hourly rate override (SEK)').fill('0');
	const zero = await saveEntry(page);
	expect(zero).toMatchObject({
		directClientId: clientWithoutRate.id, projectId: null, billable: true, assignedRateOrePerHour: '0', billableAmountOre: '0',
	});

	await openEditor(page, 'Rounded one-minute entry');
	await expect(page.getByLabel('Billability').locator('option:checked')).toHaveText('Use default (non-billable)');
	await page.getByLabel('Minutes', { exact: true }).fill('1');
	await page.getByLabel('Billability').selectOption({ label: 'Billable' });
	await page.getByLabel('Hourly rate override (SEK)').fill('0,30');
	const rounded = await saveEntry(page);
	expect(rounded).toMatchObject({
		directClientId: null, projectId: null, billable: true, assignedRateOrePerHour: '30', billableAmountOre: '1',
	});
	await expect(page.getByRole('article').filter({ hasText: 'Rounded one-minute entry' })).toContainText('0,01 SEK');

	await page.getByRole('link', { name: 'Projects', exact: true }).click();
	const editorial = page.getByRole('article', { name: 'Editorial', exact: true });
	await editorial.getByRole('button', { name: 'Edit' }).click();
	await page.getByLabel('Name', { exact: true }).fill('Editorial work');
	await page.getByLabel('Client', { exact: true }).selectOption({ label: 'No client' });
	await page.getByRole('button', { name: 'Save changes' }).click();
	await expect(page.getByRole('alert')).toContainText('This project has time entries. Select its original client');
	await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Editorial work');
	await page.getByLabel('Client', { exact: true }).selectOption({ label: 'Studio' });
	await page.getByRole('button', { name: 'Save changes' }).click();
	await expect(page.getByRole('article', { name: 'Editorial work', exact: true })).toBeVisible();

	await page.goto(`/entries/${first.id}`);
	await expect(page.getByText('Editorial work', { exact: true })).toBeVisible();
	await expect(page.getByText('Studio', { exact: true })).toBeVisible();
	await expect(page.getByText('1 200,00 SEK', { exact: true })).toBeVisible();
	const { scrollWidth, clientWidth } = await page.evaluate(() => ({
		scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth,
	}));
	expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
});
