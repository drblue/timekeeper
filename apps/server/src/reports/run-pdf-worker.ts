import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { ReportJobResponse } from '@timekeeper/contracts';
import { maxReportPdfBytes } from './job-limits.ts';

type RenderFailureCode = NonNullable<ReportJobResponse['errorCode']>;
export type RenderResult = { pdf: Buffer } | { errorCode: RenderFailureCode };
const worker = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './pdf-worker.ts' : './pdf-worker.js', import.meta.url));

export function runPdfWorker(input: string, timeoutMs: number, signal: AbortSignal, workerPath = worker): Promise<RenderResult> {
	return new Promise((resolve) => {
		if (signal.aborted) {
			resolve({ errorCode: 'REPORT_RENDER_FAILED' });
			return;
		}
		const child = spawn(process.execPath, ['--max-old-space-size=384', workerPath], {
			env: { LANG: 'C.UTF-8', TZ: 'UTC' },
			stdio: ['pipe', 'pipe', 'ignore', 'ipc'],
		});
		let failure: RenderFailureCode | undefined;
		let length = 0;
		const chunks: Buffer[] = [];
		const abort = () => child.kill('SIGKILL');
		signal.addEventListener('abort', abort, { once: true });
		const timer = setTimeout(() => {
			failure = 'REPORT_TIMEOUT';
			abort();
		}, timeoutMs);
		child.stdin!.on('error', () => {
			// The renderer may close its input while the parent is writing, e.g. on timeout.
		});
		child.stdout!.on('data', (chunk: Buffer) => {
			length += chunk.length;
			if (length > maxReportPdfBytes) {
				failure = 'REPORT_OUTPUT_TOO_LARGE';
				abort();
			} else {
				chunks.push(chunk);
			}
		});
		child.on('error', () => { failure ??= 'REPORT_RENDER_FAILED'; });
		child.on('close', (code) => {
			clearTimeout(timer);
			signal.removeEventListener('abort', abort);
			if (failure) {
				resolve({ errorCode: failure });
				return;
			}
			if (code === 2) {
				resolve({ errorCode: 'REPORT_OUTPUT_TOO_LARGE' });
				return;
			}
			const pdf = Buffer.concat(chunks, length);
			if (code !== 0 || !pdf.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
				resolve({ errorCode: 'REPORT_RENDER_FAILED' });
				return;
			}
			resolve({ pdf });
		});
		child.stdin!.end(input);
	});
}
