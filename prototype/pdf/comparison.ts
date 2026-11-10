import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { cpus, release, tmpdir, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { healthPath } from '@timekeeper/contracts';
import { isRendererName, rendererNames } from './comparison-worker.js';
import type { RendererName, WorkerMetrics } from './comparison-worker.js';
import { fixtureNames } from './fixtures.js';

const exec = promisify(execFile);
const workerScript = fileURLToPath(new URL('./comparison-worker.js', import.meta.url));
const workerTimeoutMs = 180_000;
const cancellationTimeoutMs = 10_000;
const sampleIntervalMs = 100;
const probeIntervalMs = 50;
const probeTimeoutMs = 1000;
const cancellation = new AbortController();

interface ProcessInfo {
	readonly pid: number;
	readonly rssKiB: number;
}

async function processTree(rootPid: number) {
	const { stdout } = await exec('ps', ['-axo', 'pid=,ppid=,rss='], { timeout: 5_000 });
	const children = new Map<number, ProcessInfo[]>();
	let root: ProcessInfo | undefined;
	for (const line of stdout.trim().split('\n')) {
		const [pid, ppid, rssKiB] = line.trim().split(/\s+/).map(Number);
		if (!pid || ppid === undefined || rssKiB === undefined || !Number.isFinite(rssKiB)) continue;
		const entry = { pid, rssKiB };
		if (pid === rootPid) root = entry;
		const siblings = children.get(ppid) ?? [];
		siblings.push(entry);
		children.set(ppid, siblings);
	}
	if (!root) return [];

	const tree = [root];
	for (const process of tree) {
		tree.push(...(children.get(process.pid) ?? []));
	}
	return tree;
}

async function sampleMemory(pid: number, signal: AbortSignal) {
	let peakSampledTreeRssKiB: number | null = null;
	let memorySamples = 0;
	while (!signal.aborted) {
		const started = performance.now();
		const tree = await processTree(pid);
		if (tree.length) {
			const rss = tree.reduce((sum, process) => sum + process.rssKiB, 0);
			peakSampledTreeRssKiB = Math.max(peakSampledTreeRssKiB ?? 0, rss);
			memorySamples++;
		}
		await sleep(Math.max(0, sampleIntervalMs - (performance.now() - started)), undefined, { signal })
			.catch((error: unknown) => {
				if (!signal.aborted) throw error;
			});
	}
	return { peakSampledTreeRssKiB, memorySamples };
}

function kill(pid: number) {
	try {
		process.kill(pid, 'SIGKILL');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
	}
}

async function stopWorker(pid: number) {
	// Chromium can start a separate process group inside the worker's tree.
	const tree = await processTree(pid).catch(() => []);
	kill(-pid);
	for (const child of tree.slice(1).reverse()) kill(child.pid);
}

async function worker(renderer: RendererName, fixture: string, output: string, measureMemory = false) {
	cancellation.signal.throwIfAborted();
	const started = performance.now();
	const child = spawn(process.execPath, [workerScript, renderer, fixture, output], {
		detached: true,
		stdio: ['ignore', 'pipe', 'inherit'],
	});
	let stdout = '';
	child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
	const exited = once(child, 'close');
	const memoryController = new AbortController();
	const pid = child.pid;
	if (!pid) {
		await exited;
		throw new Error('Failed to start a comparison worker.');
	}

	let stopping: Promise<void> | undefined;
	const stop = () => {
		if (child.exitCode !== null || child.signalCode !== null) return;
		memoryController.abort();
		stopping ??= stopWorker(pid).catch((error: unknown) => {
			console.error(error);
			child.kill('SIGKILL');
		});
	};
	cancellation.signal.addEventListener('abort', stop, { once: true });
	let timedOut = false;
	const timeout = setTimeout(() => {
		timedOut = true;
		stop();
	}, workerTimeoutMs);
	const result = exited.then(([code, signal]) => {
		const wallMs = performance.now() - started;
		cancellation.signal.throwIfAborted();
		if (timedOut) throw new Error(`${renderer} exceeded ${workerTimeoutMs} ms rendering ${fixture}.`);
		if (code !== 0) throw new Error(`${renderer} failed rendering ${fixture} (${signal ?? code}).`);
		const metrics = JSON.parse(stdout) as WorkerMetrics;
		return { ...metrics, wallMs };
	}).finally(() => {
		clearTimeout(timeout);
		memoryController.abort();
	});
	try {
		const memory = measureMemory ? sampleMemory(pid, memoryController.signal) : {};
		const [metrics, samples] = await Promise.all([result, memory]);
		return { ...metrics, ...samples };
	} finally {
		cancellation.signal.removeEventListener('abort', stop);
		stop();
		if (stopping) {
			await stopping;
			await exited;
		}
	}
}

async function checkHealth(url: string) {
	const response = await fetch(url, { signal: AbortSignal.timeout(probeTimeoutMs) });
	const body = await response.text();
	if (!response.ok || body !== '{"status":"ok"}') throw new Error('Unexpected liveness response.');
}

async function probe(url: string, until: Promise<unknown>) {
	let active = true;
	const stop = () => { active = false; };
	const ended = until.then(stop, stop);
	const latencies: number[] = [];
	let failures = 0;
	while (active) {
		const started = performance.now();
		try {
			await checkHealth(url);
			latencies.push(performance.now() - started);
		} catch {
			failures++;
		}
		await Promise.race([ended, sleep(Math.max(0, probeIntervalMs - (performance.now() - started)))]);
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

function assertFixture(name: string) {
	if (!fixtureNames.some((fixture) => fixture === name)) {
		throw new Error(`Unknown fixture ${name}. Choose ${fixtureNames.join(', ')}.`);
	}
}

function parseRenderers(selection: string) {
	if (selection === 'all') return rendererNames;
	const selected = selection.split(',');
	if (!selected.every(isRendererName) || new Set(selected).size !== selected.length) {
		throw new Error(`Choose distinct renderer names from ${rendererNames.join(', ')} or all.`);
	}
	return selected;
}

async function render(selection = 'all', fixture = 'all', output = 'output/pdf/comparison') {
	const renderers = parseRenderers(selection);
	if (fixture !== 'all') assertFixture(fixture);
	for (const name of fixture === 'all' ? fixtureNames : [fixture]) {
		for (const renderer of renderers) {
			const directory = resolve(output, renderer);
			const metrics = await worker(renderer, name, directory);
			console.log(JSON.stringify({ renderer, fixture: name, directory, ...metrics }));
		}
	}
}

async function benchmark(fixture = 'detailed-en', repetitionsText = '3', outputPath?: string, selection = 'all') {
	assertFixture(fixture);
	const renderers = parseRenderers(selection);
	const repetitions = Number(repetitionsText);
	if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 20) {
		throw new Error('Repetitions must be an integer from 1 to 20.');
	}

	const { createApp } = await import(new URL('../../../apps/server/dist/app.js', import.meta.url).href);
	const api: {
		listen: (options: { host: string; port: number }) => Promise<string>;
		close: () => Promise<void>;
	} = await createApp();
	const temp = await mkdtemp(join(tmpdir(), 'timekeeper-pdf-comparison-'));
	try {
		const address = await api.listen({ host: '127.0.0.1', port: 0 });
		const health = new URL(healthPath, address).href;
		await checkHealth(health);
		const baseline = await probe(health, sleep(2000, undefined, { signal: cancellation.signal }));
		cancellation.signal.throwIfAborted();
		const samples = [];
		for (let round = 0; round < repetitions; round++) {
			for (let offset = 0; offset < renderers.length; offset++) {
				// Rotate the first renderer each round to spread any time-order effect.
				const renderer = renderers[(round + offset) % renderers.length]!;
				const pending = worker(renderer, fixture, join(temp, renderer), true);
				const [metrics, responsiveness] = await Promise.all([pending, probe(health, pending)]);
				samples.push({ renderer, repetition: round + 1, ...metrics, responsiveness });
			}
		}
		const result = {
			fixture,
			environment: {
				node: process.version,
				platform: process.platform,
				arch: process.arch,
				osRelease: release(),
				cpu: cpus()[0]?.model,
				logicalCpus: cpus().length,
				totalMemoryBytes: totalmem(),
				chromiumExecutableOverride: process.env.PDF_CHROMIUM_EXECUTABLE_PATH ?? null,
			},
			workerTimeoutMs,
			probeIntervalMs,
			probeTimeoutMs,
			memorySampleIntervalMs: sampleIntervalMs,
			memorySampling: 'Maximum simultaneous sum of worker and descendant RSS from ps snapshots. Shared pages can be counted in more than one process. Transient peaks can be missed.',
			baseline,
			samples,
		};
		const json = JSON.stringify(result, null, '\t') + '\n';
		cancellation.signal.throwIfAborted();
		if (outputPath) {
			const path = resolve(outputPath);
			await mkdir(dirname(path), { recursive: true });
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
}

const [command, ...args] = process.argv.slice(2);
let cancellationTimer: NodeJS.Timeout | undefined;
function interrupt(signal: NodeJS.Signals) {
	if (cancellation.signal.aborted) return;
	const exitCode = signal === 'SIGINT' ? 130 : 143;
	process.exitCode = exitCode;
	cancellationTimer = setTimeout(() => process.exit(exitCode), cancellationTimeoutMs).unref();
	cancellation.abort(new Error(`Comparison interrupted by ${signal}.`));
}

process.on('SIGINT', interrupt);
process.on('SIGTERM', interrupt);
try {
	if (command === 'render') await render(...args);
	else if (command === 'benchmark') await benchmark(...args);
	else throw new Error('Choose render or benchmark.');
	cancellation.signal.throwIfAborted();
} catch (error) {
	if (error !== cancellation.signal.reason || !cancellation.signal.aborted) throw error;
	console.error(String(error));
} finally {
	clearTimeout(cancellationTimer);
	process.off('SIGINT', interrupt);
	process.off('SIGTERM', interrupt);
}
