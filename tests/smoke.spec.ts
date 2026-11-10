import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { healthPath } from '@timekeeper/contracts';

function waitForHealth(page: Page) {
	return page.waitForResponse((response) => new URL(response.url()).pathname === healthPath);
}

test('loads the production UI and connects to Fastify on the same origin', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	page.on('console', (message) => {
		if (message.type() === 'error') {
			errors.push(message.text());
		}
	});
	const firstCheck = waitForHealth(page);
	const scriptResponse = page.waitForResponse((response) =>
		response.request().resourceType() === 'script' && new URL(response.url()).pathname.startsWith('/assets/'),
	);

	const documentResponse = await page.goto('/');
	expect(documentResponse?.status()).toBe(200);
	expect(documentResponse?.headers()['cache-control']).toBe('no-cache');
	await expect(page).toHaveTitle('Timekeeper');
	await expect(page.getByRole('heading', { name: 'Timekeeper' })).toBeVisible();
	const response = await firstCheck;

	expect(response.url()).toBe(new URL(healthPath, page.url()).href);
	expect(response.status()).toBe(200);
	expect(await response.json()).toEqual({ status: 'ok' });
	await expect(page.getByRole('status')).toHaveText('API connected');
	const asset = await scriptResponse;
	expect(asset.status()).toBe(200);
	expect(asset.headers()['cache-control']).toContain('immutable');
	expect(errors).toEqual([]);
});

test('shows an invalid response as unavailable and recovers on recheck', async ({ page }) => {
	await page.route(healthPath, (route) => route.fulfill({ json: { status: 'invalid' } }));
	await page.goto('/');
	await expect(page.getByRole('status')).toHaveText('Could not connect to the API.');

	await page.unroute(healthPath);
	const retry = waitForHealth(page);
	await page.getByRole('button', { name: 'Check connection' }).click();

	expect((await retry).status()).toBe(200);
	await expect(page.getByRole('status')).toHaveText('API connected');
});
