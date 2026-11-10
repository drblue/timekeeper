import { fileURLToPath } from "node:url";
import type { Prisma, PrismaClient as SqliteClient } from "../generated/sqlite/client.ts";

export type Provider = "sqlite" | "postgresql" | "mariadb";

type Allocation = { localDate: string; seconds: number };
type TimeEntry = {
	id: string;
	description: string;
	effectiveHourlyRateOre: string | null;
	billableAmountOre: string;
	startedAt: string | null;
	workDate: string | null;
	allocations: Allocation[];
};

export type ProjectSnapshot = { id: string; name: string; entries: TimeEntry[] };

type FixtureClient = Pick<SqliteClient, "$queryRaw" | "$disconnect"> & {
	fixtureProject: Pick<SqliteClient["fixtureProject"], "create" | "findUnique" | "delete">;
	fixtureTimeEntry: Pick<SqliteClient["fixtureTimeEntry"], "create">;
	fixtureEntryDayAllocation: Pick<SqliteClient["fixtureEntryDayAllocation"], "create">;
	$transaction(operations: Prisma.PrismaPromise<unknown>[]): Promise<unknown[]>;
};

async function connect(provider: Provider, url: string): Promise<FixtureClient> {
	switch (provider) {
		case "sqlite": {
			const { PrismaBetterSqlite3 } = await import("@prisma/adapter-better-sqlite3");
			const { PrismaClient } = await import("../generated/sqlite/client.ts");
			return new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: fileURLToPath(url) }) });
		}
		case "postgresql": {
			const { PrismaPg } = await import("@prisma/adapter-pg");
			const { PrismaClient } = await import("../generated/postgresql/client.ts");
			return new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
		}
		case "mariadb": {
			const { PrismaMariaDb } = await import("@prisma/adapter-mariadb");
			const { PrismaClient } = await import("../generated/mariadb/client.ts");
			return new PrismaClient({ adapter: new PrismaMariaDb(url) });
		}
	}
}

export async function openFixture(provider: Provider, url: string) {
	const database = await connect(provider, url);

	function entryCreate(projectId: string, entry: TimeEntry) {
		return database.fixtureTimeEntry.create({
			data: {
				id: entry.id,
				projectId,
				description: entry.description,
				effectiveHourlyRateOre: entry.effectiveHourlyRateOre === null ? null : BigInt(entry.effectiveHourlyRateOre),
				billableAmountOre: BigInt(entry.billableAmountOre),
				startedAt: entry.startedAt === null ? null : new Date(entry.startedAt),
				workDate: entry.workDate,
				allocations: { create: entry.allocations },
			},
		});
	}

	return {
		async saveProject(project: ProjectSnapshot) {
			await database.$transaction([
				database.fixtureProject.create({ data: { id: project.id, name: project.name } }),
				...project.entries.map((entry) => entryCreate(project.id, entry)),
			]);
		},
		async readProject(id: string): Promise<ProjectSnapshot | null> {
			const project = await database.fixtureProject.findUnique({
				where: { id },
				include: {
					entries: {
						orderBy: { id: "asc" },
						include: { allocations: { orderBy: { localDate: "asc" } } },
					},
				},
			});
			if (project === null) return null;

			return {
				id: project.id,
				name: project.name,
				entries: project.entries.map((entry) => ({
					id: entry.id,
					description: entry.description,
					effectiveHourlyRateOre: entry.effectiveHourlyRateOre?.toString() ?? null,
					billableAmountOre: entry.billableAmountOre.toString(),
					startedAt: entry.startedAt?.toISOString() ?? null,
					workDate: entry.workDate,
					allocations: entry.allocations.map(({ localDate, seconds }) => ({ localDate, seconds })),
				})),
			};
		},
		async saveEntry(projectId: string, entry: TimeEntry) {
			await entryCreate(projectId, entry);
		},
		async saveAllocation(entryId: string, allocation: Allocation) {
			await database.fixtureEntryDayAllocation.create({ data: { entryId, ...allocation } });
		},
		async deleteProject(id: string) {
			await database.fixtureProject.delete({ where: { id } });
		},
		async databaseVersion() {
			const rows = provider === "sqlite"
				? await database.$queryRaw<{ version: string }[]>`SELECT sqlite_version() AS version`
				: await database.$queryRaw<{ version: string }[]>`SELECT VERSION() AS version`;
			return rows[0]?.version;
		},
		async close() {
			await database.$disconnect();
		},
	};
}
