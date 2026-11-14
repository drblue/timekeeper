import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
	authSessionPath, clientsPath, csrfHeader, entriesPath, parseAuthSessionResponse, parseClientResponse,
	parseEntryResponse, parseProjectResponse, parseReportSettingsResponse, projectsPath, reportLogoPath, reportSettingsPath,
	parseReportJobResponse, reportJobsPath, reportPdfPath, stockholmDateRange,
} from '@timekeeper/contracts';

async function signIn(page: Page) {
	await page.goto('/login');
	await page.getByLabel('Email address').fill('operator@example.test');
	await page.getByLabel('Password', { exact: true }).fill('Browser test initial password');
	await page.getByRole('button', { name: 'Sign in' }).click();
	await page.getByRole('link', { name: 'Entries', exact: true }).waitFor();
	const session = parseAuthSessionResponse(await (await page.request.get(authSessionPath)).json());
	const headers = { Origin: new URL(page.url()).origin, [csrfHeader]: session.csrfToken };
	return async (path: string, data: object) => {
		const result = await page.request.post(path, { headers, data });
		expect(result.ok()).toBe(true);
		return result.json();
	};
}

const standard = { projectId: null, directClientId: null, rateOverrideOrePerHour: '80000', billable: true };

test('opens from filtered work, keeps exact day values and time-only default, and restores list context', async ({ page }) => {
	const post = await signIn(page);
	const client = parseClientResponse(await post(clientsPath, { name: 'Report client', defaultRateOrePerHour: '80000', notes: null }));
	const project = parseProjectResponse(await post(projectsPath, {
		name: 'Project Alpha', clientId: client.id, rateOverrideOrePerHour: null, notes: null,
	}));
	await post(entriesPath, {
		...standard, kind: 'timed', description: 'Monthly [.*] summary', projectId: project.id,
		startLocal: '2026-08-31T23:30:00', endLocal: '2026-09-01T00:30:00',
	});
	for (let index = 0; index < 25; index += 1) {
		await post(entriesPath, {
			...standard, kind: 'duration-only', description: 'Monthly [.*] summary',
			localDate: '2026-09-02', durationSeconds: 60, projectId: project.id, rateOverrideOrePerHour: '60000',
		});
	}
	await post(entriesPath, {
		...standard, kind: 'duration-only', description: 'Monthly unrelated summary', localDate: '2026-09-02', durationSeconds: 1800,
	});
	const listed = '/entries?preset=custom&from=2026-09-01&to=2026-10-01&description=%5B.*%5D&sort=oldest&page=2';
	await page.goto(listed);
	await expect(page.getByText('Page 2 of 2')).toBeVisible();
	const launch = page.getByRole('link', { name: 'Report preview', exact: true });
	await launch.click();
	await expect(page.getByRole('heading', { name: 'Report preview' })).toBeFocused();
	const reportUrl = new URL(page.url());
	expect(reportUrl.searchParams.get('description')).toBe('[.*]');
	expect(reportUrl.searchParams.get('page')).toBeNull();
	expect(reportUrl.searchParams.get('sort')).toBeNull();
	const totals = page.getByLabel('Report totals');
	await expect(totals).toContainText('55 min');
	await expect(totals).not.toContainText('SEK');
	const daily = page.getByRole('region', { name: 'Daily hours' });
	await daily.getByText('View daily values').click();
	await expect(daily.getByRole('row', { name: /Tue,? 1 Sept.*30 min/ })).toBeVisible();
	await expect(daily.getByRole('row', { name: /Thu,? 3 Sept.*0 s/ })).toBeVisible();
	await daily.getByLabel('Month', { exact: true }).selectOption('2026-10');
	await expect(daily.getByRole('row', { name: /Thu,? 1 Oct.*0 s/ })).toBeVisible();
	const projectLegend = page.getByLabel('Project duration and share');
	await expect(projectLegend).toContainText('Project Alpha');
	await expect(projectLegend).toContainText(/100\s?%/);
	const summaries = page.getByRole('region', { name: 'Work by description' });
	await expect(summaries.getByRole('row')).toHaveCount(2);
	await expect(summaries).not.toContainText('SEK');
	await page.getByLabel('Show rates and billable amounts').check();
	await expect(totals).toContainText(/650,00\sSEK/);
	await expect(summaries.getByRole('row')).toHaveCount(3);
	await expect(summaries).toContainText(/800,00\sSEK\/h/);
	await expect(summaries).toContainText(/600,00\sSEK\/h/);
	await expect(summaries).not.toContainText('Monthly unrelated summary');
	await page.reload();
	await expect(page.getByLabel('Show rates and billable amounts')).toBeChecked();
	await expect(totals).toContainText(/650,00\sSEK/);
	expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
	await page.getByRole('link', { name: 'Back to time entries' }).click();
	await expect(launch).toBeFocused();
	const returned = new URL(page.url()).searchParams;
	expect(returned.get('page')).toBe('2');
	expect(returned.get('sort')).toBe('oldest');
	expect(returned.get('description')).toBe('[.*]');
});

test('keeps all project shares, applies edited filters and shows an empty report honestly', async ({ page }) => {
	const post = await signIn(page);
	const client = parseClientResponse(await post(clientsPath, { name: 'Report client A', defaultRateOrePerHour: null, notes: null }));
	const project = parseProjectResponse(await post(projectsPath, {
		name: 'Project Beta', clientId: client.id, rateOverrideOrePerHour: null, notes: null,
	}));
	const otherProject = parseProjectResponse(await post(projectsPath, {
		name: 'Project Beta', clientId: client.id, rateOverrideOrePerHour: null, notes: null, confirmDuplicate: true,
	}));
	const common = { ...standard, kind: 'duration-only', localDate: '2026-10-20', description: 'Report split shares' };
	await post(entriesPath, { ...common, projectId: project.id, durationSeconds: 28_800 });
	const marked = parseEntryResponse(await post(entriesPath, { ...common, projectId: otherProject.id, durationSeconds: 28_800 }));
	await post(entriesPath + '/' + marked.id + '/invoice', { revision: marked.revision, invoiceNumber: '000016' });
	await post(entriesPath, { ...common, billable: false, durationSeconds: 1 });
	await page.goto('/reports/preview?preset=custom&from=2026-10-20&to=2026-10-21&description=Report+split+shares');
	const legend = page.getByLabel('Project duration and share');
	await expect(legend.getByRole('listitem')).toHaveCount(3);
	const summary = page.getByRole('region', { name: 'Work by description' });
	for (const id of [project.id, otherProject.id]) {
		const name = 'Project Beta · ID ' + id.slice(0, 8);
		await expect(legend.getByText(name, { exact: true })).toBeVisible();
		await expect(summary.getByText('Report client A · ' + name, { exact: true })).toBeVisible();
	}
	await expect(legend.getByRole('listitem').filter({ hasText: 'No project' })).toContainText(/<0,01\s?%/);
	const open = page.getByRole('button', { name: /^Filters/ });
	await open.click();
	await expect(page.getByLabel('Sort', { exact: true })).toHaveCount(0);
	await page.getByLabel('Invoice status', { exact: true }).selectOption('invoiced');
	await page.getByLabel('Search invoice number').fill('000016');
	await page.getByRole('button', { name: 'Apply filters' }).click();
	await expect(legend.getByRole('listitem')).toHaveCount(1);
	await expect(legend).toContainText(/100\s?%/);
	await open.click();
	await page.getByLabel('Search description').fill('Nothing matches');
	await page.getByRole('button', { name: 'Apply filters' }).click();
	await expect(page.getByRole('region', { name: 'Time by project' })).toContainText('No time recorded in this range.');
	await expect(legend).toHaveCount(0);
	await expect(page.getByRole('region', { name: 'Work by description' })).toContainText('No completed work matches these filters.');
	await page.getByText('View daily values').click();
	await expect(page.getByRole('region', { name: 'Daily hours' }).getByRole('row', { name: /21 Oct.*0 s/ })).toBeVisible();
	expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
});

test('persists report branding and previews a Swedish appendix independently of the app language', async ({ page }) => {
	const post = await signIn(page);
	await post(entriesPath, {
		...standard, kind: 'timed', description: 'Planering och överlämning',
		startLocal: '2026-11-16T23:45:00', endLocal: '2026-11-17T00:15:00',
	});
	await page.goto('/reports/preview?preset=custom&from=2026-11-17&to=2026-11-17');
	await page.getByLabel('Report language').selectOption('sv');
	await page.getByLabel('Include detailed entries').check();
	const appendix = page.getByRole('region', { name: 'Detaljerade tidposter' });
	await expect(appendix.getByRole('row', { name: /2026-11-17.*Planering och överlämning.*15 min/ })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Report preview' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Tidrapport' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Tid per dag' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Tid per projekt' })).toBeVisible();
	await expect(appendix).not.toContainText('SEK');
	await page.getByLabel('Show rates and billable amounts').check();
	await expect(appendix).toContainText(/200,00\sSEK/);

	await page.getByRole('link', { name: 'Report branding' }).click();
	const heading = page.getByRole('heading', { name: 'Report branding' });
	await expect(heading).toBeFocused();
	const name = page.getByLabel('Business or owner name');
	await name.fill('Ångström & Söner');
	await page.getByRole('button', { name: 'Save name' }).click();
	await expect(page.getByText('Business name saved.')).toBeVisible();
	const file = page.getByLabel('Choose a logo');
	await file.setInputFiles({ name: 'invalid.png', mimeType: 'image/png', buffer: Buffer.from('Not a PNG') });
	await page.getByRole('button', { name: 'Upload logo' }).click();
	await expect(page.getByRole('alert')).toContainText('Choose a valid 8-bit non-interlaced PNG image.');
	await expect(file).toBeFocused();
	await name.fill('Draft business name');
	// A valid 1×1 RGBA PNG fixture.
	const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPj/HwADAgH/5ncLrgAAAABJRU5ErkJggg==', 'base64');
	await file.setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: png });
	await page.getByRole('button', { name: 'Upload logo' }).click();
	await expect(page.getByText('Logo saved.')).toBeVisible();
	await expect(name).toHaveValue('Draft business name');
	const logo = page.getByRole('img', { name: 'Saved report logo' });
	await expect(logo).toHaveJSProperty('naturalWidth', 1);
	await page.reload();
	await expect(name).toHaveValue('Ångström & Söner');
	await expect(logo).toHaveJSProperty('naturalWidth', 1);
	const logoUrl = await logo.getAttribute('src');
	await page.route(logoUrl!, (route) => route.abort(), { times: 1 });
	await page.getByRole('link', { name: 'Back to report preview' }).click();
	await expect(page.getByText('Det gick inte att läsa in den sparade logotypen.')).toBeVisible();
	await expect(page.locator('.report-identity img')).toHaveCount(0);
	await page.getByRole('button', { name: 'Uppdatera logotyp' }).click();
	await expect(page.getByText('Ångström & Söner')).toBeVisible();
	await expect(appendix).toContainText(/200,00\sSEK/);
	await expect(page.locator('.report-identity img')).toHaveJSProperty('naturalWidth', 1);
	await expect(page.getByLabel('Report language')).toHaveValue('sv');
	await expect(page.getByLabel('Include detailed entries')).toBeChecked();

	await page.getByRole('link', { name: 'Report branding' }).click();
	const remove = page.getByRole('button', { name: 'Remove logo', exact: true });
	await remove.click();
	await expect(page.getByText('Remove the saved logo from future time reports?')).toBeFocused();
	await page.getByRole('button', { name: 'Cancel removal' }).click();
	await expect(remove).toBeFocused();
	await expect(logo).toBeVisible();
	await remove.click();
	const current = parseReportSettingsResponse(await (await page.request.get(reportSettingsPath)).json());
	const session = parseAuthSessionResponse(await (await page.request.get(authSessionPath)).json());
	const replacement = await page.request.put(reportLogoPath + '?expectedLogoId=' + current.logo?.id, {
		headers: { Origin: new URL(page.url()).origin, [csrfHeader]: session.csrfToken, 'Content-Type': 'image/png' },
		data: png,
	});
	expect(replacement.status()).toBe(200);
	const newerLogo = parseReportSettingsResponse(await replacement.json()).logo;
	expect(newerLogo?.id).not.toBe(current.logo?.id);
	await page.getByRole('button', { name: 'Confirm removal' }).click();
	await expect(page.getByRole('alert')).toContainText('The saved logo changed in another session.');
	await expect(logo).toHaveAttribute('src', newerLogo!.url);
	await expect(page.getByRole('heading', { name: 'Report logo' })).toBeFocused();
	await remove.click();
	await page.getByRole('button', { name: 'Confirm removal' }).click();
	await expect(page.getByText('Logo removed.')).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Report logo' })).toBeFocused();
	await expect(logo).toHaveCount(0);
	await page.getByRole('link', { name: 'Back to report preview' }).click();
	await expect(page.locator('.report-identity img')).toHaveCount(0);
	await expect(page.getByText('Ångström & Söner')).toBeVisible();
	expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
});

test('downloads the generated PDF for its original scope after report filters change and reload', async ({ page, request }) => {
	const post = await signIn(page);
	const range = stockholmDateRange('previous-month', new Date().toISOString());
	const previousDate = new Date(Date.parse(range.from + 'T00:00:00Z') - 86_400_000).toISOString().slice(0, 10);
	const entry = parseEntryResponse(await post(entriesPath, {
		...standard, kind: 'timed', description: 'PDF November review',
		startLocal: previousDate + 'T23:45:00', endLocal: range.from + 'T00:15:00',
	}));
	await page.goto('/reports/preview?preset=previous-month&description=PDF+November&language=sv&showMoney=true&includeDetails=true');
	const pdf = page.getByRole('region', { name: 'PDF report' });
	const generate = pdf.getByRole('button', { name: 'Generate PDF' });
	await expect(generate).toBeEnabled();
	const created = page.waitForResponse((response) => response.url().endsWith(reportPdfPath) && response.request().method() === 'POST');
	await generate.click();
	const response = await created;
	expect(response.status()).toBe(202);
	expect(response.request().postDataJSON()).toMatchObject({
		preset: 'custom', from: range.from, to: range.to, description: 'PDF November',
		language: 'sv', showMoney: 'true', includeDetails: 'true',
	});
	const job = parseReportJobResponse(await response.json());
	await expect(pdf).toContainText(range.from + ' to ' + range.to + ' · Swedish · Rates and amounts · Detailed entries');
	await page.getByRole('button', { name: 'Today', exact: true }).click();
	await expect(pdf).toContainText('This PDF uses an earlier selection.');
	await page.reload();
	await expect(pdf).toContainText('This PDF uses an earlier selection.');
	const downloadLink = pdf.getByRole('link', { name: 'Download PDF' });
	await expect(downloadLink).toBeVisible({ timeout: 20_000 });
	const downloadPath = reportJobsPath + '/' + job.id + '/download';
	await expect(downloadLink).toHaveAttribute('href', downloadPath);
	expect((await request.get(downloadPath)).status()).toBe(401);
	const waiting = page.waitForEvent('download');
	await downloadLink.click();
	const download = await waiting;
	expect(download.suggestedFilename()).toMatch(/\.pdf$/);
	const file = await download.path();
	expect((await readFile(file)).subarray(0, 5).toString()).toBe('%PDF-');
	const saved = parseEntryResponse(await (await page.request.get(entriesPath + '/' + entry.id)).json());
	expect(saved.invoicedAt).toBeUndefined();
	expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);

	const unexpectedDownloads: string[] = [];
	page.on('download', (file) => unexpectedDownloads.push(file.suggestedFilename()));
	await page.route('**' + downloadPath, (route) => route.fulfill({
		status: 410, json: { code: 'REPORT_EXPIRED', message: 'The PDF download has expired.' },
	}));
	await downloadLink.click();
	await expect(page).toHaveURL(new URL(downloadPath, page.url()).href);
	await expect(page.locator('body')).toContainText('REPORT_EXPIRED');
	expect(unexpectedDownloads).toEqual([]);
	await page.goBack();
	await expect(pdf).toContainText('This PDF uses an earlier selection.');
	await expect(generate).toBeEnabled();
});

test('recovers a PDF status failure and retries the original scope after a terminal job failure', async ({ page }) => {
	const post = await signIn(page);
	await post(entriesPath, {
		...standard, kind: 'duration-only', description: 'PDF retry fixture', localDate: '2026-11-25', durationSeconds: 1800,
	});
	await page.goto('/reports/preview?preset=custom&from=2026-11-25&to=2026-11-25&description=PDF+retry');
	const pdf = page.getByRole('region', { name: 'PDF report' });
	await page.route('**' + reportPdfPath, (route) => route.fulfill({
		status: 429, json: { code: 'REPORT_QUEUE_FULL', message: 'The PDF queue is full.' },
	}), { times: 1 });
	await pdf.getByRole('button', { name: 'Generate PDF' }).click();
	await expect(pdf.getByRole('alert')).toContainText('The PDF queue is full.');
	await page.route('**' + reportJobsPath + '/*', (route) => route.abort(), { times: 1 });
	await pdf.getByRole('button', { name: 'Retry PDF request' }).click();
	await expect(pdf.getByRole('alert')).toContainText('Could not check the PDF status.');
	await page.route('**' + reportJobsPath + '/*', async (route) => {
		const fetched = await route.fetch();
		const result = parseReportJobResponse(await fetched.json());
		await route.fulfill({ response: fetched, json: { ...result, status: 'failed',
			expiresAt: null, downloadUrl: null, errorCode: 'REPORT_TIMEOUT' } });
	}, { times: 1 });
	await pdf.getByRole('button', { name: 'Check PDF status' }).click();
	await expect(pdf).toContainText('PDF generation failed.');
	await expect(pdf).toContainText('The report took too long.');
	await page.getByLabel('Report language').selectOption('sv');
	await expect(pdf).toContainText('This PDF uses an earlier selection.');
	const response = page.waitForResponse((item) => item.url().endsWith(reportPdfPath) && item.request().method() === 'POST');
	await pdf.getByRole('button', { name: 'Generate this PDF again' }).click();
	const retry = await response;
	expect(retry.status()).toBe(202);
	expect(retry.request().postDataJSON()).toMatchObject({
		from: '2026-11-25', to: '2026-11-25', description: 'PDF retry', language: 'en', showMoney: 'false', includeDetails: 'false',
	});
	await expect(pdf.getByRole('link', { name: 'Download PDF' })).toBeVisible({ timeout: 20_000 });
});
