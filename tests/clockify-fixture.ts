import type { Page } from '@playwright/test';

export const headers = [
	'Project', 'Client', 'Description', 'Task', 'User', 'Group', 'Email', 'Tags', 'Start Date', 'Start Time',
	'End Date', 'End Time', 'Duration (h)', 'Duration (decimal)', 'Date of creation',
];

export function record(description: string, {
	client = 'A client', user = 'Alva Example', email = 'alva@example.test', tags = '', date = '25/10/2026',
	start = '09:00:00', end = '10:00:00', duration = '01:00:00',
} = {}) {
	return ['A project', client, description, '', user, '', email, tags, date, start, date, end, duration, '1.00', date]
		.map((field) => '"' + field.replaceAll('"', '""') + '"').join(',');
}

export function file(name: string, lines: string[]) {
	return { name, mimeType: 'text/csv', buffer: Buffer.from(lines.join('\r\n') + '\r\n') };
}

export async function signIn(page: Page) {
	await page.goto('/login');
	await page.getByLabel('Email address').fill('operator@example.test');
	await page.getByLabel('Password', { exact: true }).fill('Browser test initial password');
	await page.getByRole('button', { name: 'Sign in' }).click();
	await page.getByRole('link', { name: 'Entries', exact: true }).waitFor();
}
