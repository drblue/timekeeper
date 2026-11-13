import { fileURLToPath } from 'node:url';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaClient } from '../generated/prisma/client.ts';

export async function openDatabase(url: string): Promise<PrismaClient> {
	const database = new PrismaClient({
		adapter: new PrismaBetterSqlite3({
			url: fileURLToPath(url),
			fileMustExist: true,
			timeout: 5_000,
		}),
		errorFormat: 'minimal',
	});

	try {
		const [mode] = await database.$queryRaw<{ journal_mode: string }[]>`PRAGMA journal_mode = WAL`;
		const [foreignKeys] = await database.$queryRaw<{ foreign_keys: number | bigint }[]>`PRAGMA foreign_keys`;
		if (mode?.journal_mode !== 'wal' || Number(foreignKeys?.foreign_keys) !== 1) {
			throw new Error('Could not enable WAL or verify foreign keys.');
		}
		await database.account.findFirst({ select: { id: true } });
		await database.session.findFirst({ select: { tokenHash: true } });
		await database.client.findFirst({ select: { id: true } });
		await database.project.findFirst({ select: { id: true } });
		await database.entry.findFirst({ select: { startAt: true, endAt: true, completion: true } });
		await database.entryDayAllocation.findFirst({ select: { entryId: true } });
		await database.entryHistory.findFirst({ select: { id: true } });
		await database.runningTimer.findFirst({ select: { id: true } });
		await database.operationReceipt.findFirst({ select: { key: true } });
		return database;
	} catch {
		await database.$disconnect();
		throw new Error('Cannot open the application database. Check its path and run npm run db:migrate.');
	}
}
