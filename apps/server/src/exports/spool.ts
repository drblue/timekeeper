import { mkdtemp, open, rm } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { ApiRequestError } from '../api-error.ts';

const maximumExportBytes = 256 * 1024 * 1024;
const maxBufferedCharacters = 64 * 1024;
export const exportCaptureTimeoutMs = 60_000;
const exportDownloadTimeoutMs = 10 * 60_000;

export function exportTooLarge(): never {
	throw new ApiRequestError(422, 'EXPORT_TOO_LARGE', 'The export exceeds the supported size. Narrow the CSV scope or use a protected backup.');
}

type ExportProducer = (consume: (source: AsyncIterable<string>) => Promise<void>) => Promise<void>;

export function createExportSpool(temporaryRoot = tmpdir(), maximumBytes = maximumExportBytes) {
	let active = false;

	return async (produce: ExportProducer, compressed: boolean, signal: AbortSignal) => {
		if (active) throw new ApiRequestError(429, 'EXPORT_BUSY', 'Another export is in progress. Try again shortly.');
		active = true;
		let directory: string | undefined;
		let output: FileHandle | undefined;
		let input: FileHandle | undefined;
		const deadline = AbortSignal.timeout(exportCaptureTimeoutMs);
		const captureSignal = AbortSignal.any([signal, deadline]);
		try {
			captureSignal.throwIfAborted();
			directory = await mkdtemp(join(temporaryRoot, 'timekeeper-export-'));
			const filename = join(directory, 'download');
			output = await open(filename, 'wx', 0o600);
			input = await open(filename, 'r');
			// On supported Unix hosts both descriptors remain usable after unlink.
			// Remove names before materializing data, so a crash leaves no export artifact.
			await rm(directory, { recursive: true, force: true });
			directory = undefined;
			const destination = output.createWriteStream();

			async function* chunks(source: AsyncIterable<string>) {
				let size = 0;
				let buffered = '';
				for await (const chunk of source) {
					captureSignal.throwIfAborted();
					size += Buffer.byteLength(chunk);
					if (size > maximumBytes) exportTooLarge();
					buffered += chunk;
					if (buffered.length >= maxBufferedCharacters) {
						yield buffered;
						buffered = '';
					}
				}
				if (buffered) yield buffered;
			}

			await produce(async (source) => {
				if (compressed) await pipeline(chunks(source), createGzip(), destination, { signal: captureSignal });
				else await pipeline(chunks(source), destination, { signal: captureSignal });
			});
			captureSignal.throwIfAborted();
			const { size } = await input.stat();
			const stream = input.createReadStream({ signal: AbortSignal.any([signal, AbortSignal.timeout(exportDownloadTimeoutMs)]) });
			let released = false;
			const release = () => {
				if (released) return;
				released = true;
				active = false;
			};
			stream.once('end', release);
			stream.once('close', release);
			return { stream, size };
		} catch (error) {
			try {
				await Promise.allSettled([input?.close(), output?.close()]);
				if (directory) await rm(directory, { recursive: true, force: true });
			} finally {
				active = false;
			}
			if (deadline.aborted) throw new ApiRequestError(429, 'EXPORT_BUSY', 'The export took too long. Try a narrower CSV scope or export again.');
			throw error;
		}
	};
}
