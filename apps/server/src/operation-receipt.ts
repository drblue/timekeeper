import { createHash } from 'node:crypto';
import { writeForAccount } from './account-write.ts';
import { ApiRequestError } from './api-error.ts';
import type { Prisma, PrismaClient } from './generated/prisma/client.ts';

export function writeWithReceipt<T extends { serverNow: string }>(
	database: PrismaClient, accountId: string, key: string, request: readonly unknown[],
	parse: (value: unknown) => T, run: (transaction: Prisma.TransactionClient) => Promise<T>,
) {
	const requestHash = createHash('sha256').update(JSON.stringify(request)).digest('hex');
	return writeForAccount(database, accountId, async (transaction) => {
		const receipt = await transaction.operationReceipt.findUnique({ where: { accountId_key: { accountId, key } } });
		if (receipt) {
			if (receipt.requestHash !== requestHash) {
				throw new ApiRequestError(409, 'IDEMPOTENCY_CONFLICT', 'This operation ID was already used for a different request.');
			}
			return parse(JSON.parse(receipt.resultSnapshot));
		}
		const result = await run(transaction);
		parse(result);
		await transaction.operationReceipt.create({ data: {
			accountId, key, requestHash, resultSnapshot: JSON.stringify(result), completedAt: new Date(result.serverNow),
		} });
		return result;
	});
}
