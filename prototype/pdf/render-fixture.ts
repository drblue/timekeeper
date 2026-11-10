import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createFixture, fixtureNames } from './fixtures.js';
import { renderReport } from './react-pdf.js';

const [requested, output = 'output/pdf'] = process.argv.slice(2);
const names = requested && requested !== 'all' ? [requested] : fixtureNames;
await mkdir(output, { recursive: true });

for (const name of names) {
	const data = createFixture(name);
	const started = performance.now();
	const bytes = await renderReport(data);
	const renderMs = performance.now() - started;
	const peakRssKiB = process.resourceUsage().maxRSS;
	const path = resolve(output, `${name}.pdf`);
	await writeFile(path, bytes);
	await writeFile(resolve(output, `${name}.json`), JSON.stringify(data, (_, value) => (
		typeof value === 'bigint' ? value.toString() : value
	), '\t') + '\n');
	console.log(JSON.stringify({ name, path, renderMs, peakRssKiB, bytes: bytes.length }));
}
