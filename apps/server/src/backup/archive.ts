import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { databaseFilename, manifestFilename } from './files.ts';

const tarBlockSize = 512;
const maximumManifestBytes = 256 * 1024;

function exited(child: ReturnType<typeof spawn>) {
	return new Promise<void>((resolve, reject) => {
		child.once('error', reject);
		child.once('close', (code) => code === 0 ? resolve() : reject(new Error('Archive tool failed')));
	});
}

export async function writeEncryptedArchive(scratch: string, recipientFile: string, outputFile: string, signal?: AbortSignal) {
	const output = await open(outputFile, 'wx', 0o600);
	try {
		const tar = spawn('tar', ['--format=ustar', '-cf', '-', '-C', scratch, manifestFilename, databaseFilename],
			{ stdio: ['ignore', 'pipe', 'ignore'] });
		const age = spawn('age', ['--encrypt', '--recipients-file', recipientFile],
			{ stdio: ['pipe', 'pipe', 'ignore'] });
		const completion = [exited(tar), exited(age), pipeline(tar.stdout, age.stdin, { signal }),
			pipeline(age.stdout, output.createWriteStream(), { signal })];
		try {
			await Promise.all(completion);
		} catch (error) {
			tar.kill();
			age.kill();
			await Promise.allSettled(completion);
			throw error;
		}
	} finally {
		await output.close();
	}
}

function octal(field: Buffer) {
	const value = field.toString('ascii').replace(/\0.*$/, '').trim();
	if (!/^[0-7]+$/.test(value)) throw new Error('Invalid tar number');
	const result = Number.parseInt(value, 8);
	if (!Number.isSafeInteger(result)) throw new Error('Invalid tar size');
	return result;
}

function tarMember(header: Buffer, expected: string) {
	const name = header.subarray(0, 100);
	const end = name.indexOf(0);
	const expectedName = Buffer.from(expected);
	if (end !== expectedName.length || !name.subarray(0, end).equals(expectedName)
		|| name.subarray(end).some(Boolean) || header.subarray(345, 500).some(Boolean)
		|| header.subarray(157, 257).some(Boolean) || header[156] !== 48
		|| !header.subarray(257, 263).equals(Buffer.from('ustar\0'))) {
		throw new Error('Unexpected archive member');
	}
	const checksum = octal(header.subarray(148, 156));
	const actual = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
	if (actual !== checksum) throw new Error('Invalid tar checksum');
	return octal(header.subarray(124, 136));
}

// Accept precisely the two regular USTAR members we create. Do not pass paths,
// links, extension records or archive modes from the input to the filesystem.
async function extractBackup(source: AsyncIterable<Buffer>, scratch: string) {
	const iterator = source[Symbol.asyncIterator]();
	let chunk: Buffer = Buffer.alloc(0);
	async function take(maximum: number) {
		while (!chunk.length) {
			const next = await iterator.next();
			if (next.done) return null;
			chunk = next.value;
		}
		const value = chunk.subarray(0, maximum);
		chunk = chunk.subarray(value.length);
		return value;
	}
	async function read(length: number) {
		const result = Buffer.alloc(length);
		let offset = 0;
		while (offset < length) {
			const value = await take(length - offset);
			if (!value) throw new Error('Truncated archive');
			offset += value.copy(result, offset);
		}
		return result;
	}
	for (const name of [manifestFilename, databaseFilename]) {
		const size = tarMember(await read(tarBlockSize), name);
		if (size === 0 || (name === manifestFilename && size > maximumManifestBytes)) throw new Error('Invalid archive member size');
		const file = await open(join(scratch, name), 'wx', 0o600);
		try {
			let remaining = size;
			while (remaining > 0) {
				const value = await take(remaining);
				if (!value) throw new Error('Truncated archive member');
				await file.writeFile(value);
				remaining -= value.length;
			}
		} finally {
			await file.close();
		}
		if ((await read((tarBlockSize - size % tarBlockSize) % tarBlockSize)).some(Boolean)) throw new Error('Invalid tar padding');
	}
	if ((await read(tarBlockSize * 2)).some(Boolean)) throw new Error('Unexpected extra archive member');
	let padding = 0;
	for (let value = await take(tarBlockSize); value; value = await take(tarBlockSize)) {
		padding += value.length;
		if (value.some(Boolean) || padding > 10_240) throw new Error('Unexpected trailing archive content');
	}
}

export async function readEncryptedArchive(inputFile: string, identityFile: string, scratch: string, signal?: AbortSignal) {
	const inputFileHandle = await open(inputFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	const input = inputFileHandle.createReadStream();
	const age = spawn('age', ['--decrypt', '--identity', identityFile], { stdio: ['pipe', 'pipe', 'ignore'] });
	const completion = [exited(age), pipeline(input, age.stdin, { signal }), extractBackup(age.stdout, scratch)];
	try {
		await Promise.all(completion);
	} catch (error) {
		age.kill();
		input.destroy();
		await Promise.allSettled(completion);
		throw error;
	}
}
