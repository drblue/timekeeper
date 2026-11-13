import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
	authSessionPath, csrfHeader, entriesPath, parseAuthSessionResponse, parseEntryHistoryResponse, parseEntryResponse,
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

test('marks the full entry, corrects invoice metadata while locked, then explicitly unmarks', async ({ page }) => {
	const headers = await signIn(page);
	const original = parseEntryResponse(await (await page.request.post(entriesPath, {
		headers, data: {
			kind: 'timed', description: 'Invoice overnight work', startLocal: '2026-09-25T23:30:00',
			endLocal: '2026-09-26T00:15:00', projectId: null, directClientId: null, rateOverrideOrePerHour: '80000', billable: true,
		},
	})).json());
	const detail = entriesPath + '/' + original.id;
	await page.goto('/entries?preset=custom&from=2026-09-26&to=2026-09-26&invoice=not-yet-invoiced');
	const row = page.getByRole('article').filter({ hasText: original.description });
	await expect(row).toContainText('15 min');
	await expect(row).toContainText('200,00 SEK');
	await row.getByRole('link').click();
	const invoice = page.getByRole('region', { name: 'Invoice', exact: true });
	const mark = invoice.getByRole('button', { name: 'Mark as invoiced', exact: true });
	await mark.press('Enter');
	await expect(invoice.getByRole('heading', { name: 'Mark entry as invoiced' })).toBeFocused();
	await expect(invoice.getByText(/1 entry · 45 min · 600,00\sSEK/)).toBeVisible();
	await expect(invoice.getByText(/applies to the whole time entry/)).toBeVisible();
	await invoice.getByRole('button', { name: 'Cancel invoice change' }).press('Enter');
	await expect(mark).toBeFocused();
	expect(parseEntryResponse(await (await page.request.get(detail)).json())).toEqual(original);

	await mark.click();
	await invoice.getByLabel('Invoice number (optional)').fill('INV-0008');
	await invoice.getByLabel('Invoice date (optional)').fill('2026-10-02');
	await invoice.getByLabel('Invoice reference (optional)').fill('Consulting, September');
	await invoice.getByRole('button', { name: 'Confirm invoice marking' }).click();
	await expect(page.getByText('Time entry marked as invoiced.')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Edit entry' })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Move to Trash' })).toHaveCount(0);
	const marked = parseEntryResponse(await (await page.request.get(detail)).json());
	expect(marked).toMatchObject({ invoiceNumber: 'INV-0008', invoiceDate: '2026-10-02', invoiceReference: 'Consulting, September' });
	expect(marked.invoicedAt?.slice(0, 10)).not.toBe(marked.invoiceDate);
	expect(marked.durationSeconds).toBe(original.durationSeconds);
	expect(marked.billableAmountOre).toBe(original.billableAmountOre);

	await invoice.getByRole('button', { name: 'Edit invoice details', exact: true }).click();
	await expect(invoice.getByLabel('Invoice number (optional)')).toHaveValue('INV-0008');
	await invoice.getByLabel('Invoice number (optional)').fill('000012');
	await invoice.getByLabel('Invoice reference (optional)').fill('');
	await invoice.getByRole('button', { name: 'Save invoice details' }).click();
	await expect(page.getByText('Invoice details updated.')).toBeVisible();
	await page.reload();
	const corrected = parseEntryResponse(await (await page.request.get(detail)).json());
	expect(corrected.invoiceNumber).toBe('000012');
	expect(corrected.invoiceReference).toBeUndefined();
	expect(corrected.invoicedAt).toBe(marked.invoicedAt);
	await expect(invoice.locator('time[datetime="2026-10-02"]')).toBeVisible();
	await expect(invoice.locator('time[datetime="' + marked.invoicedAt + '"]')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Edit entry' })).toHaveCount(0);
	await page.getByRole('link', { name: 'Back to time entries' }).click();
	expect(new URL(page.url()).searchParams.get('invoice')).toBe('not-yet-invoiced');
	await expect(row).toHaveCount(0);
	await page.getByRole('button', { name: /^Filters/ }).click();
	await page.getByLabel('Invoice status', { exact: true }).selectOption('invoiced');
	await page.getByLabel('Search invoice number').fill('000012');
	await page.getByRole('button', { name: 'Apply filters' }).click();
	await expect(row).toContainText('Invoiced · 000012');
	await row.getByRole('link').click();

	const unmark = invoice.getByRole('button', { name: 'Unmark invoice', exact: true });
	await unmark.click();
	await invoice.getByRole('button', { name: 'Cancel invoice change' }).click();
	await expect(unmark).toBeFocused();
	expect(parseEntryResponse(await (await page.request.get(detail)).json())).toEqual(corrected);
	await unmark.click();
	await invoice.getByRole('button', { name: 'Confirm unmark' }).click();
	await expect(page.getByText('Time entry unmarked.')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Edit entry' })).toBeEnabled();
	await expect(page.getByRole('button', { name: 'Move to Trash' })).toBeEnabled();
	const unmarked = parseEntryResponse(await (await page.request.get(detail)).json());
	expect(unmarked).toEqual({ ...original, revision: original.revision + 3 });

	await page.getByRole('button', { name: 'Show history' }).click();
	const history = page.getByRole('region', { name: 'History' });
	await expect(history.getByRole('heading', { name: 'Marked as invoiced' })).toBeVisible();
	await expect(history.getByRole('heading', { name: 'Updated invoice details' })).toBeVisible();
	await expect(history.getByRole('heading', { name: 'Unmarked invoice' })).toBeVisible();
	await expect(history.getByText('After: 000012')).toBeVisible();
	expect(parseEntryHistoryResponse(await (await page.request.get(detail + '/history')).json()).slice(0, 3).map((row) => row.action))
		.toEqual(['invoice-unmarked', 'invoice-metadata-updated', 'invoice-marked']);
	expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
});

test('retains the invoice draft when a revision changes and permits blank metadata', async ({ page }) => {
	const headers = await signIn(page);
	const original = parseEntryResponse(await (await page.request.post(entriesPath, {
		headers, data: {
			kind: 'duration-only', localDate: '2026-09-25', durationSeconds: 1800,
			description: 'Invoice revision check', projectId: null, directClientId: null, rateOverrideOrePerHour: '0', billable: true,
		},
	})).json());
	const detail = entriesPath + '/' + original.id;
	await page.goto('/entries/' + original.id);
	const invoice = page.getByRole('region', { name: 'Invoice', exact: true });
	const mark = invoice.getByRole('button', { name: 'Mark as invoiced', exact: true });
	await mark.click();
	const invoiceNumber = invoice.getByLabel('Invoice number (optional)');
	await invoiceNumber.fill('Draft-0001');
	expect((await page.request.put(detail, {
		headers, data: {
			revision: original.revision, description: 'Invoice revision updated',
			projectId: null, directClientId: null, billable: true,
		},
	})).ok()).toBe(true);
	await invoice.getByRole('button', { name: 'Confirm invoice marking' }).click();
	await expect(invoice.getByRole('alert')).toContainText('The saved entry changed in another session.');
	await expect(invoiceNumber).toHaveValue('Draft-0001');
	await invoice.getByRole('button', { name: 'Check saved entry' }).click();
	await expect(page.getByRole('heading', { name: 'Invoice revision updated' })).toBeVisible();
	await expect(invoice.getByRole('heading', { name: 'Mark entry as invoiced' })).toBeFocused();
	await expect(invoiceNumber).toHaveValue('Draft-0001');
	await expect(invoice.getByRole('button', { name: 'Confirm invoice marking' })).toBeDisabled();
	await invoice.getByRole('button', { name: 'Cancel invoice change' }).click();
	await mark.click();
	await invoice.getByRole('button', { name: 'Confirm invoice marking' }).click();
	await expect(page.getByText('Time entry marked as invoiced.')).toBeVisible();
	const marked = parseEntryResponse(await (await page.request.get(detail)).json());
	expect(marked.invoicedAt).toBeTruthy();
	expect(marked).not.toHaveProperty('invoiceNumber');
	expect(marked).not.toHaveProperty('invoiceDate');
	expect(marked).not.toHaveProperty('invoiceReference');
});
