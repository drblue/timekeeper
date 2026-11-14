import { inflateSync } from 'node:zlib';
import { maxReportLogoBytes, maxReportLogoDimension } from '@timekeeper/contracts';
import { PNG } from 'pngjs';
import { ApiRequestError } from '../api-error.ts';

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const samples = new Map([[0, 1], [2, 3], [3, 1], [4, 2], [6, 4]]);

function invalidLogo(): never {
	throw new ApiRequestError(422, 'INVALID_REPORT_LOGO', 'Choose a valid 8-bit non-interlaced PNG image.');
}

export function decodeReportLogo(input: Buffer) {
	if (input.byteLength > maxReportLogoBytes) {
		throw new ApiRequestError(422, 'REPORT_LOGO_TOO_LARGE', 'Choose a PNG image no larger than 1 MiB.');
	}
	if (input.length < 45 || !input.subarray(0, 8).equals(pngSignature) || input.readUInt32BE(8) !== 13
		|| input.toString('ascii', 12, 16) !== 'IHDR') invalidLogo();
	const width = input.readUInt32BE(16);
	const height = input.readUInt32BE(20);
	if (width < 1 || height < 1 || width > maxReportLogoDimension || height > maxReportLogoDimension) {
		throw new ApiRequestError(422, 'REPORT_LOGO_DIMENSIONS', `Choose a logo at most ${maxReportLogoDimension} × ${maxReportLogoDimension} pixels.`);
	}
	const channels = samples.get(input[25]!);
	if (input[24] !== 8 || !channels || input[26] !== 0 || input[27] !== 0 || input[28] !== 0) invalidLogo();

	const compressed: Buffer[] = [];
	let ended = false;
	for (let cursor = 8; cursor < input.length;) {
		if (input.length - cursor < 12) invalidLogo();
		const length = input.readUInt32BE(cursor);
		const kind = input.toString('ascii', cursor + 4, cursor + 8);
		const next = cursor + length + 12;
		if (next > input.length || (kind === 'IHDR' && cursor !== 8) || kind === 'acTL') invalidLogo();
		if (kind === 'IDAT') compressed.push(input.subarray(cursor + 8, next - 4));
		if (kind === 'IEND') {
			if (length !== 0 || next !== input.length) invalidLogo();
			ended = true;
		}
		cursor = next;
	}
	if (!ended || !compressed.length) invalidLogo();

	let bytes: Buffer;
	try {
		// Validate the exact decompressed size independently. pngjs caps output, which by itself can hide overlong image data.
		const scanlineBytes = (width * channels + 1) * height;
		if (inflateSync(Buffer.concat(compressed), { maxOutputLength: scanlineBytes }).length !== scanlineBytes) invalidLogo();
		const decoded = PNG.sync.read(input, { checkCRC: true });
		const canonical = new PNG();
		canonical.width = width;
		canonical.height = height;
		canonical.data = decoded.data;
		bytes = PNG.sync.write(canonical, { colorType: 6, deflateLevel: 6 });
	} catch {
		return invalidLogo();
	}
	if (bytes.byteLength > maxReportLogoBytes) {
		throw new ApiRequestError(422, 'REPORT_LOGO_TOO_LARGE', 'The normalized PNG is larger than 1 MiB. Choose a smaller logo.');
	}
	return { width, height, bytes };
}
