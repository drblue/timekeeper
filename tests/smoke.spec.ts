import { expect, test } from '@playwright/test';
import { authSessionPath, healthPath } from '@timekeeper/contracts';

test('loads the production sign-in page and connects to Fastify on the same origin', async ({ page, request }) => {
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	page.on('console', (message) => {
		if (message.type() === 'error') {
			errors.push(message.text());
		}
	});
	const firstSession = page.waitForResponse((response) => new URL(response.url()).pathname === authSessionPath);
	const scriptResponse = page.waitForResponse((response) =>
		response.request().resourceType() === 'script' && new URL(response.url()).pathname.startsWith('/assets/'),
	);

	const documentResponse = await page.goto('/');
	expect(documentResponse?.status()).toBe(200);
	expect(documentResponse?.headers()['cache-control']).toBe('no-cache');
	await expect(page).toHaveTitle('Timekeeper');
	await expect(page).toHaveURL(/\/login$/);
	await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
	const response = await firstSession;

	expect(response.url()).toBe(new URL(authSessionPath, page.url()).href);
	expect(response.status()).toBe(200);
	expect(response.headers()['cache-control']).toBe('no-store');
	expect(await response.json()).toEqual({ account: null, csrfToken: expect.any(String) });
	const asset = await scriptResponse;
	expect(asset.status()).toBe(200);
	expect(asset.headers()['cache-control']).toContain('immutable');

	const health = await request.get(healthPath);
	expect(health.status()).toBe(200);
	expect(await health.json()).toEqual({ status: 'ok' });
	expect(errors).toEqual([]);
});

test('shows an invalid session response as unavailable and recovers on recheck', async ({ page }) => {
	await page.route(authSessionPath, (route) => route.fulfill({ json: { account: null } }));
	await page.goto('/');
	await expect(page.getByRole('heading', { name: 'Connection unavailable' })).toBeVisible();
	await expect(page.getByRole('alert')).toHaveText('Could not check your session. Check your connection and try again.');

	await page.unroute(authSessionPath);
	await page.getByRole('button', { name: 'Try again' }).click();
	await expect(page).toHaveURL(/\/login$/);
	await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});
