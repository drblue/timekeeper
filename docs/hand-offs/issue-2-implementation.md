# Issue 2 implementation handoff

- Ticket [#2, Verify persistence on all three database engines](https://github.com/drblue/timekeeper/issues/2)
- Branch `dev`, base `8af4780`, implementation revision `6f39d98aee2b7917de7298a559b3693b729046bd`
- Implementation model `gpt-6.1-sol`, high reasoning

The fixture commits a project with time entries and day allocations, disconnects, then reopens the database and compares the stored data with the expected snapshot. It checks UUID and foreign-key preservation, exact signed 64-bit amounts as decimal strings, null and zero rates, UTC instants for two occurrences of the same local clock time, a leap-day date string, and exact Unicode text with trailing spaces and a description over 65,535 UTF-8 bytes. Failed writes exercise transaction rollback, orphan rejection, restricted deletion, and primary and composite uniqueness. The composite key permits multiple dates for one entry and reuse of a date across entries.

Each provider has its own schema, generated client, and migration history. Fixture code shares typed operations across the three clients. MariaDB uses `LONGTEXT`, `utf8mb4_nopad_bin`, and InnoDB, and stores instants as UTC `DATETIME(0)`. PostgreSQL uses `TIMESTAMPTZ(0)`. The SQLite migration CLI receives a file URL while its native adapter receives a decoded file path. The fixture sets `RUST_LOG=info` for Prisma subprocesses because the ambient `warn` value caused an empty SQLite migration error on macOS. [Prisma issue #29355](https://github.com/prisma/orm/issues/29355)

## Pinned stack

| Component | Tested version |
| --- | --- |
| Node.js / npm | 24.19.0 / 11.17.0 |
| Prisma CLI, generated client, and each of the three adapters | 7.10.1 |
| SQLite / `better-sqlite3` | 3.53.2 / 12.11.1 |
| PostgreSQL / `pg` | 18.4 (`postgres:18.4-alpine`) / 8.23.1 |
| MariaDB / `mariadb` driver | 11.8.8 (`mariadb:11.8.8`) / 3.5.4 |

## Run locally

```sh
npm ci
npm run typecheck:persistence
TZ=America/New_York npm run test:persistence
```

Use local Docker Compose for the full suite. `npm run test:persistence -- sqlite` runs without Docker. Pass `postgresql` or `mariadb` to run just that server's fixture. The runner makes a temporary SQLite directory and a unique `timekeeper-portability-<UUID>` Compose project, publishes the server databases on Docker-assigned loopback ports, and removes its temporary files, containers, and volumes on completion. It constructs its own connection URLs. If the run is interrupted, identify its exact project name with `docker compose ls --all` and replace `timekeeper-portability-UUID` in the cleanup command.

```sh
docker compose --file prisma/fixture/compose.yaml --env-file /dev/null \
	--project-name timekeeper-portability-UUID down --volumes
```

Run the same SQLite check in fresh Linux containers from the repository root. `git archive` supplies only committed source and each container installs its own architecture's dependencies.

```sh
for platform in linux/arm64 linux/amd64; do
	git archive HEAD | docker run --rm -i --platform "$platform" \
		node:24.19.0-bookworm-slim sh -ec '
			mkdir /tmp/timekeeper
			cd /tmp/timekeeper
			tar -xf -
			npm ci --no-fund --no-audit
			npm run test:persistence -- sqlite
		'
done
```

## Verification

| Execution environment | Observed result |
| --- | --- |
| Native Apple Silicon macOS, Node reported `darwin/arm64` | SQLite migration and round trip passed. The loaded native driver returned `3.53.2`. |
| Linux ARM64 in Docker Desktop's ARM64 VM, Node reported `linux/arm64` | Fresh install, SQLite migration, and round trip passed. The loaded native driver returned `3.53.2`. |
| Linux x86-64 under emulation on the same ARM64 host, Node reported `linux/x64` | Fresh install, SQLite migration, and round trip passed. The loaded x86-64 driver returned `3.53.2`. |
| PostgreSQL and MariaDB in Docker Desktop's ARM64 VM, called from the native macOS fixture | Both provider migrations and round trips passed with the Node process running in `America/New_York`. PostgreSQL reported `18.4` on `aarch64-unknown-linux-musl` and MariaDB reported `11.8.8-MariaDB-ubu2404`. |

`npm run typecheck:persistence` passed. `PLAYWRIGHT_BROWSERS_PATH=/private/tmp/timekeeper-playwright npm run check` passed the app type checks, production build, six API tests, and four Chromium tests. The Debian slim containers reported a Prisma OpenSSL detection warning and completed migrations and queries. npm reported install-script notices for Prisma and the native SQLite dependency, and both loaded successfully.

## Scope and next action

Physical Raspberry Pi and x86-64 host execution were unavailable. These results establish the feasibility fixture on three real engines and actual driver loading on the reported process architectures. Production schema design and deployment qualification belong to later tickets. Full SQLite data transfer to either server remains optional future work.

## Independent acceptance gates

Final code revision: `6f39d98aee2b7917de7298a559b3693b729046bd`. Documentation revision reviewed: `64ab2ebbf1784952193666e5a92c8fc33c604fa5`.

- **Independent validation — gpt-6.1-terra, high reasoning:** reran the integrated fixture under `TZ=America/New_York` and fixture type checks; SQLite 3.53.2, PostgreSQL 18.4 and MariaDB 11.8.8 passed. Independently used an archive of the exact code revision for fresh Linux ARM64 and emulated Linux x86-64 installs and SQLite runs; both passed. Confirmed isolated container/network cleanup. The existing full application check also passed (type checks, build, six API tests, four Chromium tests).
- **Independent review — gpt-6-astra, high reasoning:** reviewed provider schemas/migrations, persistence boundary, assertions, temporary-resource cleanup, dependency changes and finalized handoff. No actionable findings. Approval covers the bounded fixture and accurately qualified execution evidence, not full production or transfer support.

The coordinator accepted the implementation after both gates passed. Physical-host testing remains unavailable; the non-failing slim-image OpenSSL warnings are recorded above rather than treated as proof of a production-ready base image.

Issue #1 was pushed and closed before this work began. Follow-up: the accepted issue #2 commits through `3a5170a` were pushed to `origin/dev` and issue #2 was closed as completed before issue #3 began.
