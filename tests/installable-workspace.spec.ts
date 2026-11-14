import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { authSessionPath, entriesPath, parseEntryListResponse, timerPath } from '@timekeeper/contracts';

async function signIn(page: Page) {
	await page.getByLabel('Email address').fill('operator@example.test');
	await page.getByLabel('Password', { exact: true }).fill('Browser test initial password');
	await page.getByRole('button', { name: 'Sign in' }).click();
}

test('serves installation assets and keeps the current work draft through a disconnect', async ({ page, context }) => {
	await page.goto('/login');
	await expect(page.getByText(/Timekeeper requires a connection to the server/)).toBeVisible();
	const manifestLink = page.locator('link[rel="manifest"]');
	await expect(manifestLink).toHaveAttribute('href', '/manifest.webmanifest');
	const manifestResponse = await page.request.get('/manifest.webmanifest');
	expect(manifestResponse.headers()['content-type']).toContain('application/manifest+json');
	const manifest = await manifestResponse.json();
	expect(manifest).toMatchObject({ name: 'Timekeeper', id: '/', start_url: '/', scope: '/', display: 'standalone' });
	expect(manifest.icons).toEqual([
		{ src: '/icons/timekeeper-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
		{ src: '/icons/timekeeper-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
		{ src: '/icons/timekeeper-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
	]);
	await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute('href', '/icons/apple-touch-icon.png');

	await signIn(page);
	await page.getByText('Install Timekeeper', { exact: true }).click();
	await expect(page.getByText(/Add to Home Screen/)).toBeVisible();
	await page.goto('/entries?description=Offline+draft');
	const timer = page.getByRole('region', { name: 'Timer', exact: true });
	const start = timer.getByRole('button', { name: 'Start timer', exact: true });
	await expect(start).toBeEnabled();
	await page.getByRole('button', { name: 'New time entry' }).click();
	const editor = page.locator('form').filter({ has: page.getByRole('button', { name: 'Save time entry', exact: true }) });
	const description = editor.getByLabel('Description', { exact: true });
	await description.fill('Offline draft review');
	await editor.getByLabel('Duration', { exact: true }).fill('3000');
	await editor.getByLabel('Billability', { exact: true }).selectOption('non-billable');
	await expect(editor.getByRole('button', { name: 'Save time entry' })).toBeEnabled();
	await context.setOffline(true);
	await expect(page.getByText('You’re offline. Reconnect to load or save work.')).toBeVisible();
	await expect(start).toBeDisabled();
	await expect(editor.getByRole('button', { name: 'Save time entry' })).toBeDisabled();
	await expect(description).toHaveValue('Offline draft review');
	await expect(editor.getByText('Reconnect to save this draft.')).toBeVisible();
	expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);

	await context.setOffline(false);
	await expect(page.getByText('You’re offline. Reconnect to load or save work.')).toHaveCount(0);
	await expect(description).toHaveValue('Offline draft review');
	await editor.getByRole('button', { name: 'Save time entry' }).click();
	await expect(page.getByText('Time entry saved.')).toBeVisible();
	const entries = parseEntryListResponse(await (await page.request.get(entriesPath)).json());
	expect(entries.find((entry) => entry.description === 'Offline draft review')).toMatchObject({ durationSeconds: 1800, billable: false });
	const session = await page.request.get(authSessionPath);
	expect(session.headers()['cache-control']).toContain('no-store');
	expect(context.serviceWorkers()).toEqual([]);
	const controller = await page.evaluate(() => !!navigator.serviceWorker?.controller);
	expect(controller).toBe(false);
	await page.getByRole('link', { name: 'Offline draft review', exact: true }).click();
	await page.getByRole('link', { name: 'Back to time entries' }).click();
	await expect(page).toHaveURL(/description=Offline\+draft/);
	expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);

	await page.route('**' + authSessionPath, (route) => route.fulfill({ status: 503, body: 'Session unavailable' }));
	await page.route('**' + timerPath, (route) => route.fulfill({ status: 401, json: { code: 'AUTH_REQUIRED' } }));
	// Returning to the workspace refreshes the timer and exposes the revoked session.
	await page.getByRole('link', { name: 'Home', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'Connection unavailable' })).toBeVisible({ timeout: 15_000 });
	await expect(page.getByRole('region', { name: 'Timer', exact: true })).toHaveCount(0);
	await expect(page.getByRole('navigation', { name: 'Workspace' })).toHaveCount(0);
	await context.clearCookies();
	await page.unroute('**' + authSessionPath);
	await page.getByRole('button', { name: 'Try again' }).click();
	await expect(page).toHaveURL(/\/login$/);

	await page.unroute('**' + timerPath);
	await signIn(page);
	await expect(page.getByRole('navigation', { name: 'Workspace' })).toBeVisible();
	let refreshes = 0;
	await page.route('**' + authSessionPath, (route) => {
		refreshes++;
		return route.fulfill({ status: refreshes === 1 ? 401 : 503, json: { code: 'AUTH_REQUIRED' } });
	});
	// Simulate returning to the browser tab, which rechecks the session.
	await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
	await expect(page.getByRole('heading', { name: 'Connection unavailable' })).toBeVisible();
	await page.getByRole('button', { name: 'Try again' }).click();
	await expect.poll(() => refreshes).toBe(2);
	await expect(page.getByRole('button', { name: 'Try again' })).toBeEnabled();
	await expect(page.getByRole('region', { name: 'Timer', exact: true })).toHaveCount(0);
	await expect(page.getByRole('navigation', { name: 'Workspace' })).toHaveCount(0);
});
