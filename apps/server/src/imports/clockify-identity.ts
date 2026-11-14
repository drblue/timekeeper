import { createHash } from 'node:crypto';
import type { ClockifySource } from '@timekeeper/contracts';
import type { Prisma } from '../generated/prisma/client.ts';

export function clockifyHash(value: unknown) {
	return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function clockifyIdentity(source: ClockifySource, startAt: string, endAt: string, seconds: number) {
	// The CSV user/email pair has no external stable ID. Preserve case and whitespace,
	// and normalize only line breaks. The rounded decimal duration is representational.
	const text = (value: string) => value.replace(/\r\n?/g, '\n');
	const userAndTimes = [text(source.user), text(source.email), startAt, endAt];
	const candidateKey = clockifyHash([1, ...userAndTimes]);
	const fingerprint = clockifyHash([1, ...userAndTimes, seconds,
		...[source.client, source.project, source.description, source.task, source.group, source.tags, source.dateOfCreation].map(text),
	]);
	return { candidateKey, fingerprint };
}

export async function previousClockifyIdentities(
	transaction: Prisma.TransactionClient, accountId: string, candidateKeys: string[],
) {
	const keys = [...new Set(candidateKeys)];
	const byCandidate = new Map<string, Set<string>>();
	for (let start = 0; start < keys.length; start += 256) {
		const matches = await transaction.clockifyImportIdentity.findMany({
			where: { accountId, candidateKey: { in: keys.slice(start, start + 256) } },
			select: { candidateKey: true, fingerprint: true },
		});
		for (const { candidateKey, fingerprint } of matches) {
			let fingerprints = byCandidate.get(candidateKey);
			if (!fingerprints) {
				fingerprints = new Set();
				byCandidate.set(candidateKey, fingerprints);
			}
			fingerprints.add(fingerprint);
		}
	}
	return byCandidate;
}
