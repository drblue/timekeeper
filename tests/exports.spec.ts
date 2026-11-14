import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { expect, test } from '@playwright/test';
import { authSessionPath, csrfHeader, entriesPath, entriesCsvExportPath, parseAuthSessionResponse, portableExportPath } from '@timekeeper/contracts';
import { signIn } from './clockify-fixture.js';

test('downloads a scoped spreadsheet-safe CSV and full portable archive', async ({ page }) => {
	await signIn(page);
	const session = parseAuthSessionResponse(await (await page.request.get(authSessionPath)).json());
	const headers = { Origin: new URL(page.url()).origin, [csrfHeader]: session.csrfToken };
	const settings = { projectId: null, directClientId: null, rateOverrideOrePerHour: '80000', billable: true };
	const night = await page.request.post(entriesPath, {
		headers,
		data: { ...settings, kind: 'timed', description: '=Night [.*] work', startLocal: '2026-09-10T23:30:00', endLocal: '2026-09-11T00:30:00' },
	});
	expect(night.status()).toBe(201);
	const excluded = await page.request.post(entriesPath, {
		headers,
		data: { ...settings, kind: 'duration-only', description: 'Outside export scope', localDate: '2026-09-11', durationSeconds: 3600 },
	});
	expect(excluded.status()).toBe(201);

	await page.goto('/entries?preset=custom&from=2026-09-11&to=2026-09-11&description=%5B.*%5D&sort=oldest&page=2');
	await expect(page.getByRole('link', { name: '=Night [.*] work' })).toBeVisible();
	await page.getByRole('link', { name: 'Exports', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'Exports' })).toBeFocused();
	const csv = page.getByRole('region', { name: 'Time entries CSV' });
	await expect(csv).toContainText('2026-09-11 to 2026-09-11');
	await expect(csv).toContainText('Description “[.*]”');
	await expect(csv).toContainText('Oldest first');
	const csvLink = csv.getByRole('link', { name: 'Download CSV' });
	const csvUrl = new URL((await csvLink.getAttribute('href'))!, page.url());
	expect(csvUrl.pathname).toBe(entriesCsvExportPath);
	expect(Object.fromEntries(csvUrl.searchParams)).toEqual({
		preset: 'custom', from: '2026-09-11', to: '2026-09-11', description: '[.*]', sort: 'oldest',
	});
	const [csvDownload] = await Promise.all([page.waitForEvent('download'), csvLink.click()]);
	expect(csvDownload.suggestedFilename()).toBe('timekeeper-entries-2026-09-11_to_2026-09-11.csv');
	expect(await csvDownload.failure()).toBeNull();
	const csvContent = await readFile((await csvDownload.path())!, 'utf8');
	expect(csvContent).toContain("2026-09-11;");
	expect(csvContent).toContain(";'=Night [.*] work;");
	expect(csvContent).toContain(';1800;00:30:00;Ja;800,00;80000;400,00;40000;');
	expect(csvContent).not.toContain('Outside export scope');

	const archive = page.getByRole('region', { name: 'Portable archive' });
	await expect(archive).toContainText('The archive excludes passwords and session secrets.');
	await expect(archive).toContainText('protected backups');
	const archiveLink = archive.getByRole('link', { name: 'Download portable archive' });
	await expect(archiveLink).toHaveAttribute('href', portableExportPath);
	const [archiveDownload] = await Promise.all([page.waitForEvent('download'), archiveLink.click()]);
	expect(archiveDownload.suggestedFilename()).toMatch(/^timekeeper-portable-\d{4}-\d{2}-\d{2}\.ndjson\.gz$/);
	expect(await archiveDownload.failure()).toBeNull();
	const archiveText = gunzipSync(await readFile((await archiveDownload.path())!)).toString('utf8');
	const archiveLines = archiveText.trimEnd().split('\n');
	const manifest = JSON.parse(archiveLines.pop()!);
	expect(manifest).toMatchObject({ section: 'manifest', data: { format: 'timekeeper-portable', formatVersion: 1 } });
	const entryLines = archiveLines.filter((line) => JSON.parse(line).section === 'entries');
	const entryHash = createHash('sha256').update(entryLines.join('\n') + '\n').digest('hex');
	expect(manifest.data.sections.entries).toEqual({ records: 2, sha256: entryHash });
	expect(archiveText).toContain('=Night [.*] work');
	expect(archiveText).toContain('Outside export scope');
	expect(archiveText).not.toContain('Browser test initial password');

	expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
	await page.getByRole('link', { name: 'Back to time entries' }).click();
	await expect(page.getByRole('link', { name: 'Exports', exact: true })).toBeFocused();
	const returned = new URL(page.url()).searchParams;
	expect(returned.get('description')).toBe('[.*]');
	expect(returned.get('sort')).toBe('oldest');
	expect(returned.get('from')).toBe('2026-09-11');
});
