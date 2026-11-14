import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';

export async function requirePrivateDirectory(path: string) {
	const info = await lstat(path);
	if (!info.isDirectory() || (info.mode & 0o077)) throw new Error('Expected a private directory');
	return realpath(path);
}

export async function readSmallFile(path: string, limit: number, privateFile = false) {
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const info = await file.stat();
		if (!info.isFile() || info.size > limit || (privateFile && (info.mode & 0o077))) {
			throw new Error('Expected a small regular file');
		}
		return await file.readFile('utf8');
	} finally {
		await file.close();
	}
}

export async function sha256File(path: string, signal?: AbortSignal) {
	const hash = createHash('sha256');
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		if (!(await file.stat()).isFile()) throw new Error('Expected regular file for checksum');
		for await (const chunk of file.createReadStream({ signal })) hash.update(chunk);
	} finally {
		await file.close();
	}
	return hash.digest('hex');
}

export async function syncFile(path: string) {
	const file = await open(path, 'r');
	try {
		await file.sync();
	} finally {
		await file.close();
	}
}

export const sha256Pattern = /^[0-9a-f]{64}$/;
export const backupFilenamePattern = /^timekeeper-(\d{4}-\d{2}-\d{2})T\d{6}Z-[0-9a-f]{16}\.tar\.age$/;
export const databaseFilename = 'timekeeper.sqlite';
export const manifestFilename = 'manifest.json';
