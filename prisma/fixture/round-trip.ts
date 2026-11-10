import assert from "node:assert/strict";
import { openFixture } from "./persistence.ts";
import type { ProjectSnapshot, Provider } from "./persistence.ts";

const projectId = "e93bd100-f908-46cb-9206-d09feffb166d";
const missingProjectId = "f7bd80ac-78bf-4d0c-9adc-9998341bfa1f";
const firstEntry = {
	id: "a1000000-0000-4000-8000-000000000001",
	description: "Översyn 👩🏽‍💻 — Киев — 日本語\n".repeat(2_100) + "end  ",
	effectiveHourlyRateOre: "9007199254740993",
	billableAmountOre: "9223372036854775807",
	startedAt: "2026-10-25T02:15:07+02:00",
	workDate: null,
	allocations: [
		{ localDate: "2026-10-25", seconds: 3_600 },
		{ localDate: "2026-10-26", seconds: 60 },
	],
};
const secondEntry = {
	id: "a1000000-0000-4000-8000-000000000002",
	description: "Översyn  ",
	effectiveHourlyRateOre: "0",
	billableAmountOre: "0",
	startedAt: "2026-10-25T02:15:07+01:00",
	workDate: null,
	allocations: [{ localDate: "2026-10-25", seconds: 3_600 }],
};
const thirdEntry = {
	id: "a1000000-0000-4000-8000-000000000003",
	description: "o\u0308versyn  ",
	effectiveHourlyRateOre: null,
	billableAmountOre: "0",
	startedAt: null,
	workDate: "2024-02-29",
	allocations: [{ localDate: "2024-02-29", seconds: 60 }],
};
const fixture: ProjectSnapshot = {
	id: projectId,
	name: "Kundportal 🗂️",
	entries: [firstEntry, secondEntry, thirdEntry],
};
const expected: ProjectSnapshot = {
	...fixture,
	entries: [
		{ ...firstEntry, startedAt: "2026-10-25T00:15:07.000Z" },
		{ ...secondEntry, startedAt: "2026-10-25T01:15:07.000Z" },
		thirdEntry,
	],
};

export async function verifyRoundTrip(provider: Provider, url: string): Promise<string> {
	assert.ok(Buffer.byteLength(firstEntry.description, "utf8") > 65_535);
	const writer = await openFixture(provider, url);
	try {
		await writer.saveProject(fixture);
	} finally {
		await writer.close();
	}

	const reader = await openFixture(provider, url);
	try {
		assert.deepEqual(await reader.readProject(projectId), expected);

		await assert.rejects(reader.saveProject({ ...fixture, id: missingProjectId }), { code: "P2002" });
		assert.equal(await reader.readProject(missingProjectId), null, "Roll back the preceding project insert");

		const missingEntryId = "a1000000-0000-4000-8000-000000000004";
		await assert.rejects(reader.saveEntry(missingProjectId, { ...thirdEntry, id: missingEntryId }), { code: "P2003" });
		await assert.rejects(reader.saveAllocation(firstEntry.id, { localDate: "2026-10-25", seconds: 1 }), { code: "P2002" });
		await assert.rejects(reader.deleteProject(projectId), { code: "P2003" });
		assert.deepEqual(await reader.readProject(projectId), expected);

		const version = await reader.databaseVersion();
		assert.ok(version, "Read database version from the engine");
		return version;
	} finally {
		await reader.close();
	}
}
