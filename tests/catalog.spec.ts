import { expect, test } from '@playwright/test';
import {
	authSessionPath,
	clientsPath,
	csrfHeader,
	maxHourlyRateOre,
	parseAuthSessionResponse,
	parseClientListResponse,
	parseProjectListResponse,
	projectsPath,
} from '@timekeeper/contracts';

test('manages client and project lifecycles and preserves exact rates and IDs', async ({ page, baseURL }) => {
	expect((await page.request.get(clientsPath)).status()).toBe(401);
	await page.goto('/projects');
	await expect(page).toHaveURL(/\/login$/);
	await page.getByLabel('Email address').fill('operator@example.test');
	await page.getByLabel('Password', { exact: true }).fill('Browser test initial password');
	await page.getByRole('button', { name: 'Sign in' }).click();
	await page.getByRole('link', { name: 'Clients' }).click();

	await expect(page.getByRole('heading', { name: 'Clients', exact: true })).toBeVisible();
	await page.getByRole('button', { name: 'New client' }).click();
	await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toBeFocused();
	await page.getByLabel('Name', { exact: true }).fill('Northwind');
	await page.getByLabel('Default hourly rate (SEK)').fill('850.001');
	await page.getByLabel('Notes').fill('Primary contact\nProject sponsor');
	await page.getByRole('button', { name: 'Create client' }).click();
	await expect(page.getByRole('alert')).toContainText('up to two decimal places');
	await page.getByLabel('Default hourly rate (SEK)').fill('850,01');
	await page.getByRole('button', { name: 'Create client' }).click();
	const client = page.getByRole('article', { name: 'Northwind', exact: true });
	await expect(client).toContainText('850.01 SEK/hour');
	await expect(client).toContainText('Project sponsor');

	await page.getByRole('button', { name: 'New client' }).click();
	await page.getByLabel('Name', { exact: true }).fill('NORTHWIND');
	await page.getByLabel('Default hourly rate (SEK)').fill('92233720368547758.07');
	await page.getByRole('button', { name: 'Create client' }).click();
	await expect(page.getByRole('alert')).toContainText('A client with this name already exists');
	await page.getByRole('button', { name: 'Save as separate client' }).click();
	await expect(page.getByRole('article', { name: 'NORTHWIND', exact: true })).toContainText('92,233,720,368,547,758.07 SEK/hour');

	const clients = parseClientListResponse(await (await page.request.get(clientsPath)).json());
	const primary = clients.find(({ name }) => name === 'Northwind')!;
	const duplicate = clients.find(({ name }) => name === 'NORTHWIND')!;
	expect(primary.id).not.toBe(duplicate.id);
	expect(primary.defaultRateOrePerHour).toBe('85001');
	expect(duplicate.defaultRateOrePerHour).toBe(maxHourlyRateOre);

	await client.getByRole('button', { name: 'Edit' }).click();
	await page.getByLabel('Name', { exact: true }).fill('Unsaved name');
	const session = parseAuthSessionResponse(await (await page.request.get(authSessionPath)).json());
	const updated = await page.request.put(`${clientsPath}/${primary.id}`, {
		headers: { Origin: baseURL!, [csrfHeader]: session.csrfToken },
		data: {
			name: 'Northwind Studio',
			defaultRateOrePerHour: primary.defaultRateOrePerHour,
			notes: primary.notes,
			revision: primary.revision,
		},
	});
	expect(updated.ok()).toBe(true);
	await page.getByRole('button', { name: 'Save changes' }).click();
	await expect(page.getByRole('alert')).toContainText('changed since you opened it');
	await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Unsaved name');
	await page.getByRole('button', { name: 'Reload saved details' }).click();
	await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Northwind Studio');
	await page.getByRole('button', { name: 'Cancel' }).click();
	const renamedClient = page.getByRole('article', { name: 'Northwind Studio', exact: true });
	await expect(renamedClient).toBeVisible();

	await page.getByRole('link', { name: 'Projects' }).click();
	await page.getByRole('button', { name: 'New project' }).click();
	await page.getByLabel('Name', { exact: true }).fill('Editorial');
	await page.getByLabel('Client', { exact: true }).selectOption({ label: 'Northwind Studio' });
	await expect(page.getByText(/Leave blank to inherit 850.01/)).toBeVisible();
	await expect(page.getByRole('checkbox', { name: 'Billable by default' })).toBeChecked();
	await page.getByLabel('Notes').fill('Cover and illustrations');
	await page.getByRole('button', { name: 'Create project' }).click();
	const project = page.getByRole('article', { name: 'Editorial', exact: true });
	await expect(project).toContainText('850.01 SEK/hour (inherited)');
	await expect(project).toContainText('Cover and illustrations');
	const [originalProject] = parseProjectListResponse(await (await page.request.get(projectsPath)).json());
	expect(originalProject).toMatchObject({
		clientId: primary.id, rateOverrideOrePerHour: null, effectiveRateOrePerHour: '85001', defaultBillable: true,
	});

	await page.getByRole('button', { name: 'New project' }).click();
	await page.getByLabel('Name', { exact: true }).fill('Editorial');
	await page.getByLabel('Client', { exact: true }).selectOption({ label: 'Northwind Studio' });
	await page.getByRole('button', { name: 'Create project' }).click();
	await expect(page.getByRole('alert')).toContainText('A project with this name already exists for this client');
	await page.getByLabel('Client', { exact: true }).selectOption({ label: 'No client' });
	await page.getByRole('button', { name: 'Create project' }).click();
	await expect(project.filter({ hasText: 'No client' })).toContainText('No hourly rate');

	await page.getByRole('button', { name: 'New project' }).click();
	await page.getByLabel('Name', { exact: true }).fill('Unassigned work');
	await page.getByLabel('Client', { exact: true }).selectOption({ label: 'NORTHWIND' });
	const archivedElsewhere = await page.request.post(`${clientsPath}/${duplicate.id}/archive`, {
		headers: { Origin: baseURL!, [csrfHeader]: session.csrfToken },
		data: { revision: duplicate.revision },
	});
	expect(archivedElsewhere.ok()).toBe(true);
	await page.getByRole('button', { name: 'Create project' }).click();
	await expect(page.getByRole('alert')).toContainText('That client is unavailable');
	await expect(page.getByLabel('Client', { exact: true }).locator('option:checked')).toHaveText('NORTHWIND (unavailable)');
	await page.getByLabel('Client', { exact: true }).selectOption({ label: 'No client' });
	await page.getByRole('button', { name: 'Create project' }).click();
	await expect(page.getByRole('article', { name: 'Unassigned work', exact: true })).toContainText('No client');

	await page.getByRole('link', { name: 'Clients' }).click();
	await renamedClient.getByRole('button', { name: 'Archive' }).click();
	await expect(renamedClient).toHaveCount(0);
	await expect(page.getByRole('checkbox', { name: 'Show archived clients' })).toBeFocused();
	await page.getByRole('checkbox', { name: 'Show archived clients' }).check();
	await expect(renamedClient).toContainText('Archived');
	const activeAfterClientArchive = parseProjectListResponse(await (await page.request.get(projectsPath)).json());
	expect(activeAfterClientArchive.map(({ id }) => id)).not.toContain(originalProject?.id);

	await page.getByRole('link', { name: 'Projects' }).click();
	await page.getByRole('button', { name: 'New project' }).click();
	await expect(page.getByLabel('Client', { exact: true }).locator('option', { hasText: 'Northwind Studio' })).toHaveCount(0);
	await page.getByRole('button', { name: 'Cancel' }).click();
	await project.filter({ hasText: 'Northwind Studio (archived client)' }).getByRole('button', { name: 'Edit' }).click();
	const clientChoice = page.getByLabel('Client', { exact: true });
	await expect(clientChoice).toHaveValue(primary.id);
	await expect(clientChoice.locator('option:checked')).toHaveText('Northwind Studio (archived)');
	await page.getByLabel('Name', { exact: true }).fill('Editorial redesign');
	await page.getByLabel('Hourly rate override (SEK)').fill('0');
	await page.getByRole('checkbox', { name: 'Billable by default' }).uncheck();
	await page.getByRole('button', { name: 'Save changes' }).click();
	const renamedProject = page.getByRole('article', { name: 'Editorial redesign', exact: true });
	await expect(renamedProject).toContainText('0.00 SEK/hour (override)');
	await expect(renamedProject).toContainText('Non-billable by default');

	await renamedProject.getByRole('button', { name: 'Archive' }).click();
	await expect(renamedProject).toHaveCount(0);
	await page.getByRole('checkbox', { name: 'Show archived projects' }).check();
	await expect(renamedProject).toContainText('Archived');
	const archivedProjects = parseProjectListResponse(await (await page.request.get(`${projectsPath}?view=management`)).json());
	expect(archivedProjects.find(({ id }) => id === originalProject?.id)).toMatchObject({
		name: 'Editorial redesign',
		archivedAt: expect.any(String),
		clientId: primary.id,
		rateOverrideOrePerHour: '0',
		effectiveRateOrePerHour: '0',
		defaultBillable: false,
	});
	await renamedProject.getByRole('button', { name: 'Restore' }).click();
	await expect(renamedProject.getByRole('button', { name: 'Archive' })).toBeVisible();

	await page.getByRole('link', { name: 'Clients' }).click();
	await page.getByRole('checkbox', { name: 'Show archived clients' }).check();
	await renamedClient.getByRole('button', { name: 'Restore' }).click();
	await expect(renamedClient.getByRole('button', { name: 'Archive' })).toBeVisible();
	await page.goto('/projects');
	await expect(renamedProject).toContainText('Northwind Studio');
	const restoredProjects = parseProjectListResponse(await (await page.request.get(projectsPath)).json());
	expect(restoredProjects.find(({ id }) => id === originalProject?.id)).toMatchObject({
		name: 'Editorial redesign', archivedAt: null, clientId: primary.id,
	});
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
		await page.evaluate(() => document.documentElement.clientWidth),
	);
});
