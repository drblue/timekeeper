import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { AccountResponse } from '@timekeeper/contracts';
import { Prisma } from '../generated/prisma/client.ts';
import type { PrismaClient } from '../generated/prisma/client.ts';
import { hashPassword, verifyPassword } from './passwords.ts';

const ownerSlot = 1;
export const sessionMaxAge = 12 * 60 * 60;

export interface AccountSession {
	account: AccountResponse;
	accountId: string;
	token: string;
}

export function randomToken(): string {
	return randomBytes(32).toString('base64url');
}

function digest(token: string): string {
	return createHash('sha256').update(token).digest('hex');
}

function newSession(accountId: string) {
	const token = randomToken();
	return {
		token,
		record: {
			accountId,
			tokenHash: digest(token),
			expiresAt: new Date(Date.now() + sessionMaxAge * 1000),
		},
	};
}

export async function createAuthStore(database: PrismaClient) {
	// Match the password work of a known account for unknown email addresses.
	const dummyHash = await hashPassword(randomToken());

	return {
		async findSession(token: string): Promise<AccountSession | null> {
			const session = await database.session.findUnique({
				where: { tokenHash: digest(token), expiresAt: { gt: new Date() } },
				select: { account: { select: { id: true, email: true } } },
			});
			if (!session) {
				return null;
			}
			return { account: { email: session.account.email }, accountId: session.account.id, token };
		},

		async login(email: string, password: string, previousToken: string | undefined): Promise<AccountSession | null> {
			const account = await database.account.findUnique({ where: { email } });
			const matches = await verifyPassword(account?.passwordHash ?? dummyHash, password);
			if (!account || !matches) {
				return null;
			}

			const session = newSession(account.id);
			return database.$transaction(async (transaction) => {
				// Take the write lock and check the verified credential before minting a session.
				// A concurrent reset or password change either wins here or revokes this session.
				const matched = await transaction.account.updateMany({
					where: { id: account.id, passwordHash: account.passwordHash },
					data: { passwordHash: account.passwordHash, updatedAt: account.updatedAt },
				});
				if (matched.count !== 1) {
					return null;
				}
				const expired = { expiresAt: { lte: new Date() } };
				await transaction.session.deleteMany({
					where: previousToken ? { OR: [expired, { tokenHash: digest(previousToken) }] } : expired,
				});
				await transaction.session.create({ data: session.record });
				return { account: { email: account.email }, accountId: account.id, token: session.token };
			});
		},

		async logout(session: AccountSession): Promise<void> {
			await database.session.deleteMany({ where: { tokenHash: digest(session.token) } });
		},

		async changePassword(session: AccountSession, currentPassword: string, newPassword: string) {
			const account = await database.account.findUniqueOrThrow({ where: { id: session.accountId } });
			if (!await verifyPassword(account.passwordHash, currentPassword)) {
				return { status: 'invalid-current-password' } as const;
			}

			const passwordHash = await hashPassword(newPassword);
			const replacement = newSession(account.id);
			return database.$transaction(async (transaction) => {
				const updated = await transaction.account.updateMany({
					where: {
						id: account.id,
						passwordHash: account.passwordHash,
						sessions: { some: { tokenHash: digest(session.token), expiresAt: { gt: new Date() } } },
					},
					data: { passwordHash },
				});
				if (updated.count !== 1) {
					return { status: 'session-ended' } as const;
				}
				await transaction.session.deleteMany({ where: { accountId: account.id } });
				await transaction.session.create({ data: replacement.record });
				return { status: 'changed', session: { ...session, token: replacement.token } } as const;
			});
		},
	};
}

export type AuthStore = Awaited<ReturnType<typeof createAuthStore>>;

export async function provisionAccount(database: PrismaClient, email: string, password: string): Promise<boolean> {
	const passwordHash = await hashPassword(password);
	try {
		await database.account.create({ data: { id: randomUUID(), ownerSlot, email, passwordHash } });
		return true;
	} catch (error) {
		if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
			return false;
		}
		throw error;
	}
}

export async function resetAccount(database: PrismaClient, password: string): Promise<boolean> {
	const passwordHash = await hashPassword(password);
	return database.$transaction(async (transaction) => {
		const updated = await transaction.account.updateMany({ where: { ownerSlot }, data: { passwordHash } });
		await transaction.session.deleteMany({ where: { account: { ownerSlot } } });
		return updated.count === 1;
	});
}
