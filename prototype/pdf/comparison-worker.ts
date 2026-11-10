import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createFixture } from './fixtures.js';
import type { ReportRenderer } from './report-data.js';

const loadRenderers = {
	'react-pdf': async () => (await import('./react-pdf.js')).renderReport,
	pdfmake: async () => (await import('./pdfmake.js')).renderPdfmakeReport,
	chromium: async () => (await import('./html-chromium.js')).renderHtmlPdf,
} satisfies Record<string, () => Promise<ReportRenderer>>;

export type RendererName = keyof typeof loadRenderers;
export const rendererNames = Object.keys(loadRenderers) as RendererName[];

export function isRendererName(value: string): value is RendererName {
	return Object.hasOwn(loadRenderers, value);
}

export interface WorkerMetrics {
	readonly renderMs: number;
	readonly peakNodeRssKiB: number;
	readonly bytes: number;
}

if (import.meta.main) {
	const [renderer, fixture, output] = process.argv.slice(2);
	if (!renderer || !isRendererName(renderer) || !fixture || !output) {
		throw new Error('Expected a renderer name, fixture name, and output directory.');
	}
	const render = await loadRenderers[renderer]();
	const data = createFixture(fixture);
	const start = performance.now();
	const bytes = await render(data);
	const renderMs = performance.now() - start;

	await mkdir(output, { recursive: true });
	await writeFile(resolve(output, `${fixture}.pdf`), bytes);
	await writeFile(resolve(output, `${fixture}.json`), JSON.stringify(data, (_, value) => (
		typeof value === 'bigint' ? value.toString() : value
	), '\t') + '\n');
	const metrics: WorkerMetrics = {
		renderMs,
		peakNodeRssKiB: process.resourceUsage().maxRSS,
		bytes: bytes.length,
	};
	console.log(JSON.stringify(metrics));
}
