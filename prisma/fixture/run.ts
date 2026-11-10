import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Provider } from "./persistence.ts";
import { verifyRoundTrip } from "./round-trip.ts";

const cwd = fileURLToPath(new URL("../../", import.meta.url));
const providers = ["sqlite", "postgresql", "mariadb"] as const;
const versions: Record<Provider, RegExp> = {
	sqlite: /^3\.53\.2$/,
	postgresql: /^PostgreSQL 18\.4\b/,
	mariadb: /^11\.8\.8-MariaDB\b/,
};

function prisma(provider: Provider, command: string[], url?: string) {
	execFileSync("prisma", [
		...command,
		"--config", "prisma/fixture/prisma.config.ts",
		"--schema", `prisma/${provider}/schema.prisma`,
	], {
		cwd,
		// SQLite migration can fail when the schema engine runs with warn/error logging (Prisma #29355).
		env: { ...process.env, RUST_LOG: "info", TIMEKEEPER_FIXTURE_DATABASE_URL: url ?? "" },
		stdio: "inherit",
	});
}

async function runProvider(provider: Provider, url: string) {
	prisma(provider, ["generate"]);
	prisma(provider, ["migrate", "deploy"], url);
	const version = await verifyRoundTrip(provider, url);
	assert.match(version, versions[provider]);
	console.log(`PASS ${provider}: ${version}`);
}

async function runSelected(selected: readonly Provider[]) {
	const sqliteDirectory = mkdtempSync(join(tmpdir(), "timekeeper-portability-"));
	const docker = [
		"compose", "--file", "prisma/fixture/compose.yaml", "--env-file", "/dev/null",
		"--project-name", `timekeeper-portability-${randomUUID()}`,
	];
	const servers = selected.filter((provider) => provider !== "sqlite");
	try {
		console.log(`${process.version} ${process.platform}/${process.arch}`);
		if (selected.includes("sqlite")) {
			await runProvider("sqlite", pathToFileURL(join(sqliteDirectory, "fixture.db")).href);
		}
		if (servers.length === 0) return;

		try {
			execFileSync("docker", [...docker, "up", "--wait", "--wait-timeout", "120", ...servers], { cwd, stdio: "inherit" });
			for (const provider of servers) {
				const privatePort = provider === "postgresql" ? "5432" : "3306";
				const endpoint = execFileSync("docker", [...docker, "port", provider, privatePort], { cwd, encoding: "utf8" }).trim();
				assert.match(endpoint, /^127\.0\.0\.1:\d+$/);
				const protocol = provider === "postgresql" ? "postgresql" : "mysql";
				await runProvider(provider, `${protocol}://fixture:fixture@${endpoint}/portability_fixture`);
			}
		} finally {
			execFileSync("docker", [...docker, "down", "--volumes"], { cwd, stdio: "inherit" });
		}
	} finally {
		rmSync(sqliteDirectory, { force: true, recursive: true });
	}
}

const [selection = "all", ...extra] = process.argv.slice(2);
const provider = providers.find((candidate) => candidate === selection);
if (extra.length > 0 || (selection !== "all" && selection !== "--typecheck" && !provider)) {
	throw new Error("Expected all, sqlite, postgresql, or mariadb");
}
if (selection === "--typecheck") {
	for (const item of providers) prisma(item, ["generate"]);
	execFileSync("tsc", ["-p", "prisma/fixture/tsconfig.json"], { cwd, stdio: "inherit" });
} else {
	await runSelected(provider ? [provider] : providers);
}
