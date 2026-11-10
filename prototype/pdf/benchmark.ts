import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { cpus, release, tmpdir, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { healthPath } from '@timekeeper/contracts';
import { fixtureNames } from './fixtures.js';

const run = promisify(execFile);
const [fixtureName = 'year-large-sv', repetitionsText = '3', outputPath] = process.argv.slice(2);
const repetitions = Number(repetitionsText);
if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 20) {
	throw new Error('Repetitions must be an integer from 1 to 20.');
}
if (!fixtureNames.some((name) => name === fixtureName)) {
	throw new Error(`Unknown fixture: ${fixtureName}. Choose ${fixtureNames.join(', ')}.`);
}

interface WorkerMetrics {
	readonly renderMs: number;
	readonly peakRssKiB: number;
	readonly bytes: number;
}

async function worker(output: string) {
	const script = fileURLToPath(new URL('./render-fixture.js', import.meta.url));
	const start = performance.now();
	const { stdout, stderr } = await run(process.execPath, [script, fixtureName, output], {
		timeout: 180_000,
		killSignal: 'SIGKILL',
	});
	if (stderr) process.stderr.write(stderr);
	const { renderMs, peakRssKiB, bytes } = JSON.parse(stdout) as WorkerMetrics;
	return { renderMs, peakRssKiB, bytes, wallMs: performance.now() - start };
}

async function probe(url: string, until: Promise<unknown>) {
	let active = true;
	void until.then(() => { active = false; }, () => { active = false; });

	const latencies: number[] = [];
	let failures = 0;
	while (active) {
		const started = performance.now();
		try {
			const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
			const body = await response.text();
			if (!response.ok || body !== '{"status":"ok"}') {
				throw new Error('Unexpected liveness response');
			}
			latencies.push(performance.now() - started);
		} catch {
			failures++;
		}
		await sleep(Math.max(0, 50 - (performance.now() - started)));
	}
	latencies.sort((a, b) => a - b);
	const percentile = (p: number) => latencies[Math.ceil(latencies.length * p) - 1] ?? null;
	return {
		requests: latencies.length + failures,
		failures,
		p50Ms: percentile(0.5),
		p95Ms: percentile(0.95),
		maxMs: latencies.at(-1) ?? null,
	};
}

const { createApp } = await import(new URL('../../../apps/server/dist/app.js', import.meta.url).href);
const api: {
	listen: (options: { host: string; port: number }) => Promise<string>;
	close: () => Promise<void>;
} = await createApp();
const temp = await mkdtemp(join(tmpdir(), 'timekeeper-pdf-'));
try {
	const address = await api.listen({ host: '127.0.0.1', port: 0 });
	const health = new URL(healthPath, address).href;
	const warmup = await fetch(health, { signal: AbortSignal.timeout(1000) });
	await warmup.text();
	const baseline = await probe(health, sleep(2000));
	const samples = [];
	for (let index = 0; index < repetitions; index++) {
		const render = worker(temp);
		const [metrics, responsiveness] = await Promise.all([render, probe(health, render)]);
		samples.push({ ...metrics, responsiveness });
	}
	const result = {
		fixture: fixtureName,
		environment: {
			node: process.version,
			platform: process.platform,
			arch: process.arch,
			osRelease: release(),
			cpu: cpus()[0]?.model,
			logicalCpus: cpus().length,
			totalMemoryBytes: totalmem(),
		},
		probeIntervalMs: 50,
		probeTimeoutMs: 1000,
		baseline,
		samples,
	};
	const json = JSON.stringify(result, null, '\t') + '\n';
	if (outputPath) {
		const path = resolve(outputPath);
		await mkdir(resolve(path, '..'), { recursive: true });
		await writeFile(path, json);
	}
	process.stdout.write(json);
	if (baseline.failures || samples.some(({ responsiveness }) => responsiveness.failures)) {
		process.exitCode = 1;
	}
} finally {
	try {
		await api.close();
	} finally {
		await rm(temp, { recursive: true, force: true });
	}
}
