import { expect, test } from '@playwright/test';
import {
	authSessionPath,
	clientsPath,
	csrfHeader,
	entriesPath,
	parseAuthSessionResponse,
	parseClientResponse,
	parseEntryListResponse,
	parseEntryResponse,
	parseSwitchTimerResponse,
	parseTimerStateResponse,
	timerPath,
	timerSwitchPath,
} from '@timekeeper/contracts';

test('switches only after confirmation and keeps a shared boundary', async ({ page }) => {
	await page.goto('/login');
	await page.getByLabel('Email address').fill('operator@example.test');
	await page.getByLabel('Password', { exact: true }).fill('Browser test initial password');
	await page.getByRole('button', { name: 'Sign in' }).click();
	await page.getByRole('link', { name: 'Entries', exact: true }).click();

	const timer = page.getByRole('region', { name: 'Timer', exact: true });
	await timer.getByRole('button', { name: 'Add details' }).click();
	await timer.getByLabel('Description (optional)').fill('Work before switching');
	await timer.getByRole('button', { name: 'Start with details' }).click();
	const switchWork = timer.getByRole('button', { name: 'Switch work', exact: true });
	await expect(switchWork).toBeEnabled();
	const entriesBefore = parseEntryListResponse(await (await page.request.get(entriesPath)).json());
	const before = parseTimerStateResponse(await (await page.request.get(timerPath)).json()).timer;
	if (!before) throw new Error('Expected current timer');
	let writes = 0;
	page.on('request', (request) => {
		if (request.method() === 'POST' && new URL(request.url()).pathname === timerSwitchPath) writes++;
	});
	await switchWork.press('Enter');
	await timer.getByLabel('Description (optional)').fill('Declined next work');
	await timer.getByRole('button', { name: 'Cancel switch' }).press('Enter');
	await expect(switchWork).toBeFocused();
	expect(writes).toBe(0);
	expect(parseTimerStateResponse(await (await page.request.get(timerPath)).json()).timer?.id).toBe(before.id);
	expect(parseEntryListResponse(await (await page.request.get(entriesPath)).json())).toEqual(entriesBefore);

	await switchWork.click();
	await timer.getByLabel('Description (optional)').fill('Confirmed next work');
	const switched = page.waitForResponse((response) => new URL(response.url()).pathname === timerSwitchPath &&
		response.request().method() === 'POST' && response.ok());
	await timer.getByRole('button', { name: 'Stop and start next' }).click();
	const result = parseSwitchTimerResponse(await (await switched).json());
	expect(result.timer).toMatchObject({ description: 'Confirmed next work', startAt: result.entry.endAt });
	expect(result.timer.id).not.toBe(before.id);
	expect(result.entry).toMatchObject({ description: 'Work before switching', startAt: before.startAt });
	await expect(timer.getByText('Confirmed next work')).toBeVisible();
	await expect(page.getByRole('link', { name: 'Work before switching', exact: true })).toBeVisible();
	expect(writes).toBe(1);

	await timer.getByRole('button', { name: 'Stop timer' }).click();
	await expect(timer.getByText('No timer running')).toBeVisible();
});

test('continues saved work at the saved rate or an explicitly chosen current default', async ({ page, context }) => {
	await page.goto('/login');
	await page.getByLabel('Email address').fill('operator@example.test');
	await page.getByLabel('Password', { exact: true }).fill('Browser test initial password');
	await page.getByRole('button', { name: 'Sign in' }).click();
	await page.getByRole('link', { name: 'Entries', exact: true }).click();

	const session = parseAuthSessionResponse(await (await page.request.get(authSessionPath)).json());
	const headers = { Origin: new URL(page.url()).origin, [csrfHeader]: session.csrfToken };
	const client = parseClientResponse(await (await page.request.post(clientsPath, {
		headers, data: { name: 'Continuation client', defaultRateOrePerHour: '90000', notes: null },
	})).json());
	const original = parseEntryResponse(await (await page.request.post(entriesPath, {
		headers, data: {
			kind: 'duration-only', localDate: '2026-11-13', durationSeconds: 1800, description: 'Continue this research',
			projectId: null, directClientId: client.id, rateOverrideOrePerHour: '80000',
		},
	})).json());
	await page.goto('/entries/' + original.id);
	const timer = page.getByRole('region', { name: 'Timer', exact: true });
	const continueButton = page.getByRole('button', { name: 'Continue work', exact: true });
	await continueButton.click();
	await expect(page.getByRole('radio', { name: /Keep saved rate.*800,00/ })).toBeChecked();
	await context.setOffline(true);
	await expect(page.getByRole('button', { name: 'Start continued timer' })).toBeDisabled();
	await page.getByRole('button', { name: 'Cancel continue' }).click();
	await expect(page.getByRole('heading', { name: original.description })).toBeFocused();
	await context.setOffline(false);
	await continueButton.click();
	await expect(page.getByRole('heading', { name: 'Continue this work' })).toBeFocused();
	await expect(page.getByRole('radio', { name: /Keep saved rate.*800,00/ })).toBeChecked();
	await expect(page.getByRole('radio', { name: /Use current default.*900,00/ })).toBeVisible();
	await page.getByRole('button', { name: 'Start continued timer' }).click();
	await expect(timer.getByText(/Billable.*800,00/)).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Continue this work' })).toHaveCount(0);
	const first = parseTimerStateResponse(await (await page.request.get(timerPath)).json()).timer;
	if (!first) throw new Error('Expected a continued timer');
	expect(first).toMatchObject({ description: original.description, directClientId: client.id, billable: true, assignedRateOrePerHour: '80000' });

	await continueButton.click();
	await expect(page.getByRole('button', { name: 'Stop and continue' })).toBeVisible();
	await page.getByRole('button', { name: 'Cancel continue' }).click();
	await expect(continueButton).toBeFocused();
	expect(parseTimerStateResponse(await (await page.request.get(timerPath)).json()).timer?.id).toBe(first.id);

	await continueButton.click();
	await page.getByRole('radio', { name: /Use current default.*900,00/ }).check();
	const changedClient = await page.request.put(clientsPath + '/' + client.id, {
		headers, data: {
			name: client.name, revision: client.revision, notes: null, defaultRateOrePerHour: '95000',
		},
	});
	expect(changedClient.ok()).toBe(true);
	await page.getByRole('button', { name: 'Stop and continue' }).click();
	await expect(page.getByRole('radio', { name: /Use current default.*950,00/ })).toBeVisible();
	await expect(page.getByRole('radio', { name: /Keep saved rate.*800,00/ })).toBeChecked();
	expect(parseTimerStateResponse(await (await page.request.get(timerPath)).json()).timer?.id).toBe(first.id);
	await page.getByRole('radio', { name: /Use current default.*950,00/ }).check();
	await page.getByRole('button', { name: 'Stop and continue' }).click();
	await expect(timer.getByText(/Billable.*950,00/)).toBeVisible();
	const second = parseTimerStateResponse(await (await page.request.get(timerPath)).json()).timer;
	expect(second).toMatchObject({ description: original.description, directClientId: client.id, billable: true, assignedRateOrePerHour: '95000' });
	expect(second?.id).not.toBe(first.id);
	const untouched = parseEntryResponse(await (await page.request.get(entriesPath + '/' + original.id)).json());
	expect(untouched).toEqual(original);
	await timer.getByRole('button', { name: 'Stop timer' }).click();
	await expect(timer.getByText('No timer running')).toBeVisible();
});
