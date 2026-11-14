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

export interface ClockifyClaim {
	occurrence: number;
	entryId: string;
	targetFingerprint: string;
	targetOccurrence: number;
}

export async function previousClockifyIdentities(
	transaction: Prisma.TransactionClient, accountId: string, candidateKeys: string[],
) {
	const keys = [...new Set(candidateKeys)];
	const byCandidate = new Map<string, Map<string, ClockifyClaim[]>>();
	function add(candidateKey: string, fingerprint: string, claim: ClockifyClaim) {
		let fingerprints = byCandidate.get(candidateKey);
		if (!fingerprints) {
			fingerprints = new Map();
			byCandidate.set(candidateKey, fingerprints);
		}
		let slots = fingerprints.get(fingerprint);
		if (!slots) {
			slots = [];
			fingerprints.set(fingerprint, slots);
		}
		slots.push(claim);
	}

	for (let start = 0; start < keys.length; start += 128) {
		const where = { accountId, candidateKey: { in: keys.slice(start, start + 128) } };
		const identities = await transaction.clockifyImportIdentity.findMany({
			where, select: { candidateKey: true, fingerprint: true, occurrence: true, entryId: true },
		});
		for (const { candidateKey, fingerprint, occurrence, entryId } of identities) {
			add(candidateKey, fingerprint, { occurrence, entryId, targetFingerprint: fingerprint, targetOccurrence: occurrence });
		}
		const aliases = await transaction.clockifyImportAlias.findMany({
			where, select: { candidateKey: true, fingerprint: true, occurrence: true, targetFingerprint: true,
				targetOccurrence: true, target: { select: { entryId: true } } },
		});
		for (const { candidateKey, fingerprint, occurrence, targetFingerprint, targetOccurrence, target } of aliases) {
			add(candidateKey, fingerprint, { occurrence, entryId: target.entryId, targetFingerprint, targetOccurrence });
		}
	}
	for (const fingerprints of byCandidate.values()) {
		for (const claims of fingerprints.values()) claims.sort((left, right) => left.occurrence - right.occurrence);
	}
	return byCandidate;
}
