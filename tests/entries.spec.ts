import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';
import {
	authSessionPath,
	clientsPath,
	csrfHeader,
	entriesPath,
	idempotencyKeyHeader,
	parseAuthSessionResponse,
	parseClientResponse,
	parseEntryListResponse,
	parseEntryResponse,
	parseProjectResponse,
	parseTimerStateResponse,
	projectsPath,
	timerPath,
	timerStopPath,
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
	const entry = parseEntryResponse(await (await saved).json());
	if (entry.kind !== 'duration-only') throw new Error('Expected a duration-only entry');
	return entry;
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
	const duration = page.getByLabel('Duration', { exact: true });
	await duration.fill('0');
	await page.getByRole('button', { name: 'Save time entry' }).click();
	await expect(duration).toBeFocused();
	await expect(duration).toHaveAccessibleDescription(/Enter a duration greater than zero/);
	await duration.fill('13000');
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
	await duration.fill('1:30:00');
	const second = await saveEntry(page);
	expect(second).toMatchObject({
		durationSeconds: 5400,
		projectId: project.id,
		assignedRateOrePerHour: '90000',
		billableAmountOre: '135000',
	});
	const savedEntries = parseEntryListResponse(await (await page.request.get(entriesPath)).json());
	expect(savedEntries.find((entry) => entry.id === first.id)).toMatchObject({
		assignedRateOrePerHour: '80000', billableAmountOre: '120000',
	});

	await openEditor(page, 'Direct client with zero rate');
	await association.selectOption({ label: clientWithoutRate.name });
	await duration.fill('1000');
	await page.getByRole('button', { name: 'Save time entry' }).click();
	await expect(page.getByRole('alert')).toContainText('Enter an hourly rate or choose Non-billable.');
	await page.getByLabel('Hourly rate override (SEK)').fill('0');
	const zero = await saveEntry(page);
	expect(zero).toMatchObject({
		directClientId: clientWithoutRate.id, projectId: null, billable: true, assignedRateOrePerHour: '0', billableAmountOre: '0',
	});

	await openEditor(page, 'Rounded one-minute entry');
	await expect(page.getByLabel('Billability').locator('option:checked')).toHaveText('Use default (non-billable)');
	await duration.fill('100');
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

test('edits compact time by keyboard and records timed work across midnight', async ({ page }) => {
	await page.clock.setFixedTime(new Date('2026-11-12T12:00:00Z'));
	await page.goto('/login');
	await page.getByLabel('Email address').fill('operator@example.test');
	await page.getByLabel('Password', { exact: true }).fill('Browser test initial password');
	await page.getByRole('button', { name: 'Sign in' }).click();
	await page.getByRole('link', { name: 'Entries', exact: true }).click();
	await openEditor(page, 'Overnight maintenance');

	const duration = page.getByLabel('Duration', { exact: true });
	const association = page.getByLabel('Association', { exact: true });
	await duration.focus();
	await expect(duration).toHaveAttribute('inputmode', 'numeric');
	await duration.pressSequentially('3000');
	await expect(duration).toHaveValue('3000');
	await duration.press('Tab');
	await expect(duration).toHaveValue('00:30:00');
	await expect(association).toBeFocused();
	await association.press('Shift+Tab');
	await expect(duration).toHaveValue('003000');
	await duration.press('Backspace');
	await expect(duration).toHaveValue('');
	await duration.pressSequentially('80000');
	await duration.press('Tab');
	await expect(duration).toHaveValue('08:00:00');

	await page.getByRole('radio', { name: 'Timed', exact: true }).check();
	const startDate = page.getByLabel('Start date', { exact: true });
	const startTime = page.getByLabel('Start time', { exact: true });
	const endDate = page.getByLabel('End date', { exact: true });
	const endTime = page.getByLabel('End time', { exact: true });
	await expect(startDate).toHaveValue('2026-11-12');
	await startTime.focus();
	await expect(startTime).toHaveAttribute('inputmode', 'numeric');
	await startTime.pressSequentially('0900');
	await startTime.press('Tab');
	await expect(startTime).toHaveValue('09:00');
	await expect(endDate).toBeFocused();
	await endDate.press('Shift+Tab');
	await startTime.pressSequentially('1030');
	await startTime.press('Tab');
	await expect(startTime).toHaveValue('10:30');
	await endDate.press('Shift+Tab');
	await startTime.pressSequentially('145');
	await startTime.press('Tab');
	await expect(startTime).toHaveValue('01:45');
	await endDate.press('Shift+Tab');
	await startTime.pressSequentially('23:30:15');
	await startTime.press('Tab');
	await expect(startTime).toHaveValue('23:30:15');
	await duration.focus();
	await duration.pressSequentially('11500');
	await expect(duration).toHaveValue('11500');
	await expect(endDate).toHaveValue('2026-11-13');
	await expect(endTime).toHaveValue('00:45:15');
	await duration.press('Tab');
	await expect(duration).toHaveValue('01:15:00');
	await expect(page.getByText('Changing the start keeps the duration.')).toBeVisible();
	await startTime.fill('2300');
	await expect(endTime).toHaveValue('00:15');
	await endTime.fill('0045');
	await expect(duration).toHaveValue('01:45:00');
	await expect(page.getByText('Changing the start keeps the end.')).toBeVisible();
	await startTime.fill('2330');
	await expect(endTime).toHaveValue('00:45');
	await expect(duration).toHaveValue('01:15:00');

	await endDate.fill('2026-11-12');
	await page.getByRole('button', { name: 'Save time entry', exact: true }).click();
	await expect(endTime).toBeFocused();
	await expect(endTime).toBeInViewport();
	await expect(endTime).toHaveAccessibleDescription(/End must be after start/);
	await expect(endDate).toHaveValue('2026-11-12');
	await endDate.fill('2026-11-13');
	const save = page.waitForResponse((response) => response.request().method() === 'POST' &&
		new URL(response.url()).pathname === entriesPath && response.status() === 201);
	await page.getByRole('button', { name: 'Save time entry', exact: true }).click();
	const saved = parseEntryResponse(await (await save).json());
	expect(saved).toMatchObject({
		kind: 'timed',
		startAt: '2026-11-12T22:30:00.000Z',
		endAt: '2026-11-12T23:45:00.000Z',
		durationSeconds: 4500,
		allocations: [
			{ localDate: '2026-11-12', seconds: 1800, amountOre: '0' },
			{ localDate: '2026-11-13', seconds: 2700, amountOre: '0' },
		],
	});
	await page.getByRole('link', { name: 'View entry' }).click();
	await expect(page.getByText('Daily allocation (Stockholm)')).toBeVisible();
	await expect(page.getByText('30 min', { exact: true })).toBeVisible();
	await expect(page.getByText('45 min', { exact: true })).toBeVisible();
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
		await page.evaluate(() => document.documentElement.clientWidth),
	);
});

test('requires a repeated-time occurrence and allows explicit overlap confirmation', async ({ page }) => {
	await page.goto('/login');
	await page.getByLabel('Email address').fill('operator@example.test');
	await page.getByLabel('Password', { exact: true }).fill('Browser test initial password');
	await page.getByRole('button', { name: 'Sign in' }).click();
	await page.getByRole('link', { name: 'Entries', exact: true }).click();
	async function fillTimedWork(description: string) {
		await openEditor(page, description);
		await page.getByRole('radio', { name: 'Timed', exact: true }).check();
		await page.getByLabel('Start date', { exact: true }).fill('2026-10-25');
		await page.getByLabel('Start time', { exact: true }).fill('0230');
		await page.getByLabel('Duration', { exact: true }).fill('10000');
	}
	const save = page.getByRole('button', { name: 'Save time entry', exact: true });
	await fillTimedWork('Clock change work');
	await save.click();
	const startOccurrence = page.getByLabel('Start time occurrence');
	await expect(startOccurrence).toBeFocused();
	await expect(startOccurrence).toHaveAccessibleDescription(/Choose which occurrence of this time you mean/);
	await startOccurrence.selectOption('earlier');
	const end = page.getByLabel('End time', { exact: true });
	await expect(end).toHaveValue('02:30');
	await expect(page.getByLabel('End time occurrence')).toHaveValue('later');
	await save.click();
	await expect(page.getByText('Time entry saved.')).toBeVisible();

	await fillTimedWork('Overlapping clock change work');
	await page.getByLabel('Start time occurrence').selectOption('earlier');
	await save.click();
	await expect(page.getByRole('alert')).toContainText('This time overlaps another timed entry.');
	await expect(page.getByRole('link', { name: 'Overlapping clock change work', exact: true })).toHaveCount(0);
	await page.getByLabel('Description', { exact: true }).fill('Revised overlapping clock change work');
	await expect(page.getByRole('button', { name: 'Save overlapping entry' })).toHaveCount(0);
	await save.click();
	await page.getByRole('button', { name: 'Save overlapping entry' }).click();
	await expect(page.getByRole('link', { name: 'Revised overlapping clock change work', exact: true })).toBeVisible();
});

test('reconciles an unconfirmed stop across two tabs and completes the saved entry', async ({ page, context }) => {
	await page.goto('/login');
	await page.getByLabel('Email address').fill('operator@example.test');
	await page.getByLabel('Password', { exact: true }).fill('Browser test initial password');
	await page.getByRole('button', { name: 'Sign in' }).click();
	await page.getByRole('link', { name: 'Entries', exact: true }).click();

	const second = await context.newPage();
	await second.goto('/entries');
	const otherTimer = second.getByRole('region', { name: 'Timer', exact: true });
	await expect(otherTimer.getByText('No timer running')).toBeVisible();
	await page.bringToFront();

	const timer = page.getByRole('region', { name: 'Timer', exact: true });
	await timer.getByRole('button', { name: 'Add details' }).click();
	await timer.getByLabel('Billability').selectOption('billable');
	await timer.getByRole('button', { name: 'Start with details' }).click();
	const stop = timer.getByRole('button', { name: 'Stop timer' });
	await expect(stop).toBeEnabled();
	const elapsed = timer.getByRole('timer', { name: 'Elapsed time' });
	await expect(elapsed).not.toHaveText('00:00:00');
	await second.bringToFront();
	await expect(otherTimer.getByRole('button', { name: 'Stop timer' })).toBeEnabled({ timeout: 15_000 });
	await page.bringToFront();

	let originalKey: string | undefined;
	const dropStopResponse = async (route: Route) => {
		originalKey = route.request().headers()[idempotencyKeyHeader];
		const response = await route.fetch();
		expect(response.status()).toBe(200);
		await route.abort('failed');
	};
	await page.route('**' + timerStopPath, dropStopResponse);
	await stop.click();
	await expect(timer.getByRole('alert')).toHaveText(/Could not confirm the timer stop/);
	await expect(timer.getByRole('link', { name: 'Complete time entry' })).toHaveCount(0);
	expect(originalKey).toBeTruthy();
	await page.unroute('**' + timerStopPath, dropStopResponse);
	await page.reload();
	const retried = page.waitForRequest((request) => new URL(request.url()).pathname === timerStopPath);
	await timer.getByRole('button', { name: 'Retry stop' }).click();
	expect((await retried).headers()[idempotencyKeyHeader]).toBe(originalKey);
	await expect(timer.getByText('Time saved as incomplete.')).toBeVisible();
	await expect(timer.getByRole('button', { name: 'Start timer' })).toBeEnabled();
	await second.bringToFront();
	await expect(otherTimer.getByText('No timer running')).toBeVisible({ timeout: 15_000 });
	const entriesBefore = parseEntryListResponse(await (await second.request.get(entriesPath)).json());
	const incomplete = entriesBefore.filter((entry) => entry.completion === 'incomplete');
	expect(incomplete).toHaveLength(1);
	expect(incomplete[0]).toMatchObject({ billableAmountOre: null, missingFields: ['description', 'rate'] });
	await second.close();

	const savedEntry = incomplete[0];
	if (!savedEntry) throw new Error('Expected an incomplete entry');
	const entryRoute = '**' + entriesPath + '/' + savedEntry.id;
	await page.route(entryRoute, (route) => route.fulfill({
		json: { ...savedEntry, endAt: savedEntry.startAt, durationSeconds: 0, missingFields: ['description', 'rate', 'duration'] },
	}));
	await timer.getByRole('link', { name: 'Complete time entry' }).click();
	await expect(page.getByText('Incomplete · Excluded from report totals.')).toBeVisible();
	const saveCompleted = page.getByRole('button', { name: 'Save completed entry' });
	await page.getByLabel('Description', { exact: true }).fill('Recovered tracked work');
	await saveCompleted.click();
	const duration = page.getByLabel('Duration', { exact: true });
	await expect(duration).toBeFocused();
	await expect(duration).toBeInViewport();
	await expect(duration).toHaveAccessibleDescription(/Enter a duration/);
	await page.unroute(entryRoute);
	await page.reload();
	await page.getByLabel('Description', { exact: true }).fill('Recovered tracked work');
	const rate = page.getByLabel('Hourly rate (SEK)', { exact: true });
	await rate.fill('99.999');
	const billability = page.getByLabel('Billability', { exact: true });
	await billability.selectOption('non-billable');
	await expect(rate).toHaveCount(0);
	await billability.selectOption('billable');
	await expect(rate).toHaveValue('99.999');
	await billability.selectOption('non-billable');
	await saveCompleted.click();
	await expect(page.getByText('Time entry completed.')).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Recovered tracked work' })).toBeVisible();
	const entriesAfter = parseEntryListResponse(await (await page.request.get(entriesPath)).json());
	expect(entriesAfter.find((entry) => entry.id === savedEntry.id)).toMatchObject({
		completion: 'complete', billable: false, assignedRateOrePerHour: null, billableAmountOre: '0',
	});
});

test('keeps confirmed elapsed time visible during disconnection and distinguishes unknown status', async ({ page, context }) => {
	await page.goto('/login');
	await page.getByLabel('Email address').fill('operator@example.test');
	await page.getByLabel('Password', { exact: true }).fill('Browser test initial password');
	await page.getByRole('button', { name: 'Sign in' }).click();
	await page.getByRole('link', { name: 'Entries', exact: true }).click();
	const timer = page.getByRole('region', { name: 'Timer', exact: true });
	await timer.getByRole('button', { name: 'Start timer' }).click();
	await expect(timer.getByRole('button', { name: 'Stop timer' })).toBeEnabled();
	const serverState = parseTimerStateResponse(await (await page.request.get(timerPath)).json());
	if (!serverState.timer) throw new Error('Expected a confirmed running timer');
	await context.setOffline(true);
	await expect(timer.getByText(/Elapsed time is estimated from the last update/)).toBeVisible();
	await expect(timer.getByRole('button', { name: 'Stop timer' })).toBeDisabled();
	const elapsed = timer.getByRole('timer', { name: 'Elapsed time' });
	const initial = await elapsed.textContent();
	await expect(elapsed).not.toHaveText(initial ?? '');
	await context.setOffline(false);
	await expect(timer.getByRole('button', { name: 'Stop timer' })).toBeEnabled();
	expect(parseTimerStateResponse(await (await page.request.get(timerPath)).json()).timer?.id).toBe(serverState.timer.id);
	await timer.getByRole('button', { name: 'Stop timer' }).click();
	await expect(timer.getByText('Time saved as incomplete.')).toBeVisible();

	const unknown = await context.newPage();
	await unknown.route('**' + timerPath, (route) => route.abort('failed'));
	await unknown.goto('/entries');
	const unknownTimer = unknown.getByRole('region', { name: 'Timer', exact: true });
	await expect(unknownTimer.getByText('Timer status unavailable.', { exact: true })).toBeVisible();
	await expect(unknownTimer.getByText('No timer running')).toHaveCount(0);
	await expect(unknownTimer.getByRole('button', { name: 'Start timer' })).toBeDisabled();
	await unknown.unroute('**' + timerPath);
	await unknownTimer.getByRole('button', { name: 'Check timer status' }).click();
	await expect(unknownTimer.getByText('No timer running')).toBeVisible();

	const longRunning = {
		...serverState,
		serverNow: new Date(Date.parse(serverState.timer.startAt) + 12 * 3_600_000).toISOString(),
	};
	await unknown.route('**' + timerPath, (route) => route.fulfill({ json: longRunning }));
	await unknown.clock.setFixedTime(new Date('2001-01-01T00:00:00Z'));
	await unknown.reload();
	await expect(unknownTimer.getByText('This timer has been running for at least 12 hours.')).toBeVisible();
	await expect(unknownTimer.getByRole('timer')).toHaveText(/^12:00:/);
	await expect(unknownTimer.getByRole('button', { name: 'Stop timer' })).toBeEnabled();
	await unknown.close();
});
