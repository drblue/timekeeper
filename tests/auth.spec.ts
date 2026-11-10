import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { accountPath, authPasswordPath } from '@timekeeper/contracts';

const email = 'operator@example.test';
const initialPassword = 'Browser test initial password';
const newPassword = 'Browser test replacement password';

async function signIn(page: Page, password: string) {
	await page.getByLabel('Email address').fill(email);
	await page.getByLabel('Password', { exact: true }).fill(password);
	await page.getByRole('button', { name: 'Sign in' }).click();
}

test('protects the workspace and supports sign-in, password change, and sign-out', async ({ page }) => {
	expect((await page.request.get(accountPath)).status()).toBe(401);
	await page.goto('/password');
	await expect(page).toHaveURL(/\/login$/);
	await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
	await expect(page.getByText('Ask your Timekeeper operator to reset it on the server.')).toBeVisible();

	await signIn(page, 'Incorrect initial password');
	await expect(page.getByRole('alert')).toContainText('The email or password is incorrect');
	await signIn(page, initialPassword);
	await expect(page.getByRole('heading', { name: 'Timekeeper' })).toBeVisible();
	const account = await page.request.get(accountPath);
	expect(account.status()).toBe(200);
	expect(await account.json()).toEqual({ email });

	await page.getByRole('link', { name: 'Change password' }).click();
	await page.reload();
	await expect(page.getByRole('heading', { name: 'Change password' })).toBeVisible();
	await page.getByLabel('Current password').fill('Incorrect current password');
	await page.getByLabel('New password', { exact: true }).fill(newPassword);
	await page.getByLabel('Confirm new password').fill('Different confirmation value');
	const submitPassword = page.getByRole('button', { name: 'Change password' });
	await submitPassword.click();
	await expect(page.getByRole('alert')).toContainText('The new passwords do not match');

	await page.getByLabel('Confirm new password').fill(newPassword);
	await submitPassword.click();
	await expect(page.getByRole('alert')).toContainText('The current password is incorrect');

	await page.getByLabel('Current password').fill(initialPassword);
	const changed = page.waitForResponse((response) => new URL(response.url()).pathname === authPasswordPath);
	await submitPassword.click();
	expect((await changed).status()).toBe(200);
	await expect(page.getByRole('status')).toHaveText('Your password was changed.');
	await expect(page.getByLabel('Current password')).toBeEmpty();
	expect((await page.request.get(accountPath)).status()).toBe(200);

	await page.getByRole('button', { name: 'Sign out' }).click();
	await expect(page).toHaveURL(/\/login$/);
	await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
	expect((await page.request.get(accountPath)).status()).toBe(401);
	await page.goto('/password');
	await expect(page).toHaveURL(/\/login$/);

	await signIn(page, initialPassword);
	await expect(page.getByRole('alert')).toContainText('The email or password is incorrect');
	await signIn(page, newPassword);
	await expect(page.getByRole('heading', { name: 'Timekeeper' })).toBeVisible();

	await page.context().clearCookies();
	await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
	await expect(page).toHaveURL(/\/login$/);
	await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});
