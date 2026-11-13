import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
	authSessionPath, clientsPath, csrfHeader, entriesPath, parseAuthSessionResponse, parseClientResponse,
	parseProjectResponse, parseWorkListResponse, projectsPath, stockholmDateRange, workListPath,
} from '@timekeeper/contracts';

async function signIn(page: Page) {
	await page.goto('/login');
	await page.getByLabel('Email address').fill('operator@example.test');
	await page.getByLabel('Password', { exact: true }).fill('Browser test initial password');
	await page.getByRole('button', { name: 'Sign in' }).click();
	await page.getByRole('link', { name: 'Entries', exact: true }).click();
	const session = parseAuthSessionResponse(await (await page.request.get(authSessionPath)).json());
	return { Origin: new URL(page.url()).origin, [csrfHeader]: session.csrfToken };
}

test('uses Stockholm shortcuts and filters allocated midnight portions and archived associations', async ({ page }) => {
	const headers = await signIn(page);
	const controls = page.locator('.work-list-controls');
	await expect(controls.getByRole('button', { name: 'This week' })).toHaveAttribute('aria-pressed', 'true');
	const week = stockholmDateRange('this-week', new Date().toISOString());
	await expect(controls).toContainText(week.from);
	await expect(controls).toContainText(week.to);
	await controls.getByRole('button', { name: 'Today' }).click();
	await expect(controls).toContainText(stockholmDateRange('today', new Date().toISOString()).from);
	await controls.getByRole('button', { name: 'Previous month' }).click();
	await expect(controls).toContainText(stockholmDateRange('previous-month', new Date().toISOString()).from);

	async function post(path: string, data: object) {
		const response = await page.request.post(path, { headers, data });
		expect(response.ok()).toBe(true);
		return response.json();
	}
	const first = parseClientResponse(await post(clientsPath, { name: 'List client', defaultRateOrePerHour: '80000', notes: null }));
	const other = parseClientResponse(await post(clientsPath, { name: 'Other client', defaultRateOrePerHour: '80000', notes: null }));
	const project = parseProjectResponse(await post(projectsPath, {
		name: 'List archive project', clientId: first.id, rateOverrideOrePerHour: null, notes: null,
	}));
	await post(entriesPath, {
		kind: 'timed', description: 'Night [.*] work', startLocal: '2026-09-10T23:30:00', endLocal: '2026-09-11T00:30:00',
		projectId: project.id, directClientId: null, rateOverrideOrePerHour: null,
	});
	await post(entriesPath, {
		kind: 'duration-only', description: 'Night unexpected work', localDate: '2026-09-11', durationSeconds: 3600,
		projectId: project.id, directClientId: null, rateOverrideOrePerHour: null,
	});
	await post(projectsPath + '/' + project.id + '/archive', { revision: project.revision });

	await controls.getByRole('button', { name: 'Custom range' }).click();
	await expect(page.getByLabel('From date')).toBeFocused();
	await page.getByLabel('From date').fill('2026-09-11');
	await page.getByLabel('To date').fill('2026-09-11');
	await page.getByLabel('Search description').fill('[.*]');
	await page.getByLabel('Client', { exact: true }).selectOption(first.id);
	await expect(page.getByLabel('Project', { exact: true }).locator('option').filter({ hasText: 'List archive project' })).toContainText('(archived)');
	await page.getByLabel('Project', { exact: true }).selectOption(project.id);
	await page.getByLabel('Invoice status', { exact: true }).selectOption('not-yet-invoiced');
	await page.getByLabel('Billability', { exact: true }).selectOption('billable');
	await page.getByRole('button', { name: 'Apply filters' }).click();
	const row = page.getByRole('article').filter({ hasText: 'Night [.*] work' });
	await expect(row).toContainText('30 min');
	await expect(row).toContainText('400,00 SEK');
	await expect(row).toContainText('Part of timed entry');
	await expect(page.getByRole('link', { name: 'Night unexpected work' })).toHaveCount(0);
	const totals = page.getByLabel('Totals for all matching days');
	await expect(totals).toContainText('30 min');
	await expect(totals).toContainText('400,00 SEK');

	await controls.getByRole('button', { name: /^Filters/ }).click();
	await page.getByLabel('Client', { exact: true }).selectOption(other.id);
	await page.getByRole('button', { name: 'Apply filters' }).click();
	await expect(page.getByText('The selected project does not belong to the selected client.', { exact: false })).toBeVisible();

	await controls.getByRole('button', { name: /^Filters/ }).click();
	await page.getByLabel('Search invoice number').fill('0012');
	await page.getByRole('button', { name: 'Apply filters' }).click();
	expect(new URL(page.url()).searchParams.get('invoiceNumber')).toBe('0012');
	await page.reload();
	await expect(controls.getByText(/Invoice number “0012”/)).toBeVisible();
});

test('restores page, sort, filters, focus and scroll after opening and editing an entry', async ({ page }) => {
	const headers = await signIn(page);
	for (let index = 0; index < 30; index++) {
		const response = await page.request.post(entriesPath, {
			headers, data: {
				kind: 'duration-only', description: 'List batch ' + String(index).padStart(2, '0'),
				localDate: '2026-08-04', durationSeconds: 60, projectId: null, directClientId: null, rateOverrideOrePerHour: '60000', billable: true,
			},
		});
		expect(response.ok()).toBe(true);
	}
	await page.goto('/entries?preset=custom&from=2026-08-04&to=2026-08-04&description=List+batch&sort=oldest');
	const query = '?preset=custom&from=2026-08-04&to=2026-08-04&description=List+batch&sort=oldest';
	const data = parseWorkListResponse(await (await page.request.get(workListPath + query)).json());
	expect(data.totalRows).toBe(30);
	expect(data.totalPages).toBe(2);
	await expect(page.getByLabel('Totals for all matching days')).toContainText('30 min');
	await expect(page.getByLabel('Totals for all matching days')).toContainText('300,00 SEK');
	await page.getByRole('button', { name: 'Next page' }).click();
	await expect(page.getByText('Page 2 of 2')).toBeVisible();
	const target = page.getByRole('link', { name: 'List batch 29', exact: true });
	await expect(target).toBeVisible();
	await target.evaluate((node) => node.scrollIntoView({ block: 'center' }));
	const before = await target.evaluate((node) => node.getBoundingClientRect().top);
	await target.click();
	await page.getByRole('button', { name: 'Edit entry' }).click();
	await page.getByLabel('Description', { exact: true }).fill('List batch 29 updated');
	await page.getByRole('button', { name: 'Preview changes' }).click();
	await page.getByRole('button', { name: 'Save changes', exact: true }).click();
	await page.getByRole('link', { name: 'Back to time entries' }).click();
	await expect(page.getByText('Page 2 of 2')).toBeVisible();
	const returned = page.getByRole('link', { name: 'List batch 29 updated', exact: true });
	await expect(returned).toBeFocused();
	expect(Math.abs(await returned.evaluate((node) => node.getBoundingClientRect().top) - before)).toBeLessThanOrEqual(8);
	const url = new URL(page.url()).searchParams;
	expect(url.get('sort')).toBe('oldest');
	expect(url.get('description')).toBe('List batch');
	expect(url.get('page')).toBe('2');
	await expect(page.getByLabel('Totals for all matching days')).toContainText('300,00 SEK');
	expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
	await returned.click();
	await page.getByRole('button', { name: 'Edit entry' }).click();
	await page.getByLabel('Description', { exact: true }).fill('Moved outside the search');
	await page.getByRole('button', { name: 'Preview changes' }).click();
	await page.getByRole('button', { name: 'Save changes', exact: true }).click();
	await page.getByRole('link', { name: 'Back to time entries' }).click();
	await expect(page.getByRole('heading', { name: 'Completed work' })).toBeFocused();
	await expect(returned).toHaveCount(0);
	await expect(page.getByLabel('Totals for all matching days')).toContainText('290,00 SEK');
	await page.getByRole('button', { name: 'Today', exact: true }).click();
	await expect(page.locator('.work-list-controls')).toContainText(stockholmDateRange('today', new Date().toISOString()).from);
	expect(new URL(page.url()).searchParams.has('returnFrom')).toBe(false);
});
