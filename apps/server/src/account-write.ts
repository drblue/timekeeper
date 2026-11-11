import { ApiRequestError } from './api-error.ts';
import type { Prisma, PrismaClient } from './generated/prisma/client.ts';

export function writeForAccount<T>(
	database: PrismaClient, accountId: string, operation: (transaction: Prisma.TransactionClient) => Promise<T>,
) {
	return database.$transaction(async (transaction) => {
		// Acquire the SQLite writer lock before checking associations, rate defaults or revisions.
		const matched = await transaction.$executeRaw`UPDATE "Account" SET "updatedAt" = "updatedAt" WHERE "id" = ${accountId}`;
		if (matched !== 1) {
			throw new ApiRequestError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
		}
		return operation(transaction);
	});
}
