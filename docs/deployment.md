# Deploy Timekeeper with Docker Compose

Use a 64-bit Raspberry Pi OS on a Pi 4 (`aarch64`, Docker `linux/arm64`) or a 64-bit Linux VPS (`x86_64`, Docker `linux/amd64`). Install Docker Engine with Compose v2 and Buildx. Keep the database on a local filesystem, preferably an SSD on the Pi. A host reverse proxy serves the chosen HTTPS hostname and connects to Timekeeper on IPv4 loopback.

The Compose stack runs one application container as UID/GID `1000:1000`, with a read-only root filesystem and a writable data bind. SQLite, its WAL and shared-memory files, and temporary report files live under the bind. Use one application instance per database. Keep the host bind private and off SMB/NFS.

## Build the images

Build both targets from the same reviewed commit. Use a fresh, immutable release tag for each revision and retain the preceding images for rollback.

On a native Linux builder for one target architecture, load both images into the builder's Docker Engine. For a remote deployment, push the pair or transfer them to the target using Docker image save/load.

```sh
release=git-REPLACE_WITH_COMMIT
docker buildx build --target runtime --load -t "timekeeper:$release" .
docker buildx build --target migration --load -t "timekeeper-migrate:$release" .
```

For a registry release, use a Buildx builder that supports both platforms. Set the registry and namespace before publishing. Check that each tag lists both target platforms.

```sh
registry=registry.example.com/your-namespace
release=git-REPLACE_WITH_COMMIT
docker buildx build --platform linux/arm64,linux/amd64 --target runtime \
  --push -t "$registry/timekeeper:$release" .
docker buildx build --platform linux/arm64,linux/amd64 --target migration \
  --push -t "$registry/timekeeper-migrate:$release" .
docker buildx imagetools inspect "$registry/timekeeper:$release"
docker buildx imagetools inspect "$registry/timekeeper-migrate:$release"
```

Use immutable registry tags or record and deploy the image index digests. Verify native loading and startup on both hosts. [Docker multi-platform builds](https://docs.docker.com/build/building/multi-platform/)

## Configure the host

Create a private directory for the data bind on first installation. If moving an existing database, follow the [rollback and restoration guidance](#rollback-and-restoration) to stage the snapshot in a separate directory.

```sh
sudo install -d -m 0700 -o 1000 -g 1000 /srv/timekeeper/data
```

Create `.env` beside [compose.yaml](../compose.yaml) using the selected images and browser-visible origin. The origin must include `https://` and any nonstandard HTTPS port, with no path or trailing slash. Keep the same data path on replacement and upgrade.

```dotenv
TIMEKEEPER_IMAGE=registry.example.com/your-namespace/timekeeper:git-REPLACE_WITH_COMMIT
TIMEKEEPER_MIGRATION_IMAGE=registry.example.com/your-namespace/timekeeper-migrate:git-REPLACE_WITH_COMMIT
TIMEKEEPER_ORIGIN=https://timekeeper.example.com
TIMEKEEPER_DATA_DIR=/srv/timekeeper/data
TIMEKEEPER_PORT=3000
# TIMEKEEPER_TRUSTED_PROXY_IPS=
```

Both images use `file:/var/lib/timekeeper/timekeeper.sqlite` inside the container. In this example the corresponding host path is `/srv/timekeeper/data/timekeeper.sqlite`. Compose publishes the app only on `127.0.0.1`. Keep the application port out of the external firewall and verify that another machine cannot connect to it. Docker documents a same-LAN exposure for loopback publishing in Engine releases before 28. Use a current supported release. [Docker port publishing](https://docs.docker.com/engine/network/port-publishing/)

The reverse proxy runs on the host in this example. Set up DNS and a certificate trusted by the desktop and phone clients. Configure an HTTP-to-HTTPS redirect and forward the full application and API on the same HTTPS origin. This example uses a dedicated Caddy site. Substitute the chosen hostname and loopback port.

```caddy
timekeeper.example.com {
	reverse_proxy 127.0.0.1:3000
}
```

With Caddy's automatic HTTPS, ensure the selected certificate challenge is reachable. For a private-only hostname, configure a certificate that clients trust. Disable caching for authenticated requests and avoid logging query strings, headers or bodies for this app. [Caddy reverse proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy) · [Caddy automatic HTTPS](https://caddyserver.com/docs/automatic-https)

Leave `TIMEKEEPER_TRUSTED_PROXY_IPS` empty unless the proxy sets the real client address. When enabling it, verify the literal immediate peer IP observed inside the application container. Host loopback publishing may present a Docker bridge gateway as that peer. Configure the proxy to overwrite inbound `X-Forwarded-For` with exactly one client address it observed or verified. Caddy's default behavior ignores inbound forwarded values when it receives clients directly. Review the chain separately if a CDN or additional proxy is present. Use only verified peer IPs in the comma-separated list. [Account operator guide](account-access.md#storage-and-https)

## Initialize and start

Run from the release checkout. For registry images, pull the pair before migration. For loaded local images, use the corresponding local tags and skip the pull.

```sh
docker compose config --quiet
docker compose --profile operations pull app migrate
docker compose run --rm --no-deps migrate
docker compose run --rm --no-deps app node apps/server/dist/auth/operator.js provision owner@example.com
docker compose up -d --wait app
```

The `migrate` service runs the reviewed Prisma migrations once when the operator invokes it. It has no network access. First-time account provisioning prompts for the password. Run it only for a new database. The normal application startup checks schema readiness and uses the existing data. [Prisma production migration command](https://docs.prisma.io/docs/cli/migrate/deploy) · [Account operator guide](account-access.md)

Check both endpoints locally and readiness through HTTPS. Substitute your actual ports and hostname. Liveness returns `200 {"status":"ok"}`. Readiness returns `200 {"status":"ready"}` only when the database and migration history match the release, and `503` when the server is running without readiness. A process that cannot start will fail both checks.

```sh
docker compose ps
curl --fail --silent --show-error http://127.0.0.1:3000/api/v1/health
curl --fail --silent --show-error http://127.0.0.1:3000/api/v1/ready
curl --fail --silent --show-error https://timekeeper.example.com/api/v1/ready
```

Sign in through HTTPS, check the browser's certificate and verify an entry and its details. If readiness fails, keep the proxy in maintenance or leave the deployment unexposed. Check `docker compose logs app`, bind permissions, and the exact runtime and migration tags before changing the database.

## Upgrade and verify persistence

1. Record the current release and image digests, review the new migration SQL, and load or pull the new image pair. Keep the prior release files and Compose configuration available.
2. Schedule a maintenance window. Quiesce traffic at the proxy, stop `app`, and ensure no other process writes to the database during the backup and migration.
3. Take and verify the protected snapshot below. Do this before the new migration against an existing database.
4. Configure the new release with the same origin and data bind. Run `docker compose config --quiet`, then `docker compose run --rm --no-deps migrate`. If it fails, keep the app stopped and retain the database and logs for diagnosis. Production changes use the reviewed migration history.
5. Run `docker compose up -d --wait --no-deps app`. Check readiness locally and through the proxy, and confirm existing work, allocations, settings, and account access before reopening traffic. Record the image digest and migration state with the deployment result.

For release verification on a disposable installation, create a representative entry and record its ID and values. Use the same data bind for a restart and then a forced application replacement. Verify the exact saved entry after each step. These commands affect only the app service and leave the one-shot migration service idle. [Docker Compose up options](https://docs.docker.com/reference/cli/docker/compose/up/)

```sh
docker compose restart app
# Check readiness and the saved entry before proceeding.
docker compose up -d --wait --no-deps --force-recreate app
# Check readiness and the same saved entry again.
```

Record the host model, `uname -m`, image digest and native Node architecture. On the disposable instance, check that the native SQLite driver opens a database and executes a query. Use the result alongside the authenticated create/read and replacement checks.

```sh
docker compose exec -T app node --input-type=module -e '
  import Database from "better-sqlite3";
  const db = new Database(":memory:");
  console.log(process.platform, process.arch, db.prepare("SELECT sqlite_version() AS version").get());
  db.close();
'
```

Earlier [production PDF benchmarks](pdf-production-verification.md) exercised native ARM64 Pi 4 and x86-64 VPS images from a previous revision. Treat those measurements as PDF workload evidence and record current Compose verification separately.

## Protect the pre-migration snapshot

With the application stopped and other writers quiesced, use the SQLite command-line tool's `.backup` command. It uses SQLite's backup mechanism to capture a consistent database including committed WAL data. Keep a complete set of any required persistent assets from the same maintenance window. Timekeeper stores report branding in SQLite. Retain the report artifact directory if ready downloads must survive restoration. Use a private working directory on a trusted host. [SQLite Backup API](https://www.sqlite.org/backup.html)

Example for the host paths above. Run with an operator identity that can read the private data bind. Replace the backup directory with a new one under a restricted parent.

```sh
(
  set -eu
  umask 077
  backup_dir=/srv/timekeeper/backups/pre-upgrade-REPLACE_WITH_TIMESTAMP
  mkdir -m 0700 "$backup_dir"
  sqlite3 -readonly /srv/timekeeper/data/timekeeper.sqlite ".backup '$backup_dir/timekeeper.sqlite'"
  journal_mode=$(sqlite3 "$backup_dir/timekeeper.sqlite" 'PRAGMA journal_mode=DELETE;')
  test "$journal_mode" = delete
  integrity=$(sqlite3 -readonly "$backup_dir/timekeeper.sqlite" 'PRAGMA integrity_check;')
  foreign_keys=$(sqlite3 -readonly "$backup_dir/timekeeper.sqlite" 'PRAGMA foreign_key_check;')
  test "$integrity" = ok
  test -z "$foreign_keys"
  cd "$backup_dir"
  sha256sum timekeeper.sqlite > SHA256SUMS
  sha256sum -c SHA256SUMS
)
```

The journal-mode change applies only to the backup copy and makes it self-contained for verification and transfer. Record the application image digest, schema and calculation versions, backup time, asset inventory, and checksums with the snapshot. Protect it as credential-bearing data. Copy it with your chosen encryption to a separate destination and verify the copied package before relying on it. Schedule daily backups with 30-day retention and test decryption and restoration. The [portable export](technical-design.md#10-sqlite-deployment-and-recovery) omits credential data. It serves data transfer and recovery workflows alongside the protected operational backup.

## Rollback and restoration

Keep traffic paused while restoring. If the new release changed the schema, use the prior compatible runtime image with the verified pre-migration snapshot. Recover into a new private bind directory, with the snapshot named `timekeeper.sqlite` and owned by `1000:1000` with mode `0600`. Restore any retained assets with matching ownership. Keep the failed or newer data directory intact for investigation and reconciliation. Use a fresh directory so SQLite does not see WAL files from the newer database.

Verify checksums and SQLite integrity on the restored copy. Point `TIMEKEEPER_DATA_DIR` and the image tags to the restored pair. Reset the restored account password to revoke sessions saved in the snapshot before reopening the service.

```sh
docker compose run --rm --no-deps app node apps/server/dist/auth/operator.js reset
docker compose up -d --wait --no-deps app
```

Check liveness, readiness, sign-in, stored work, allocations, history and invoice status. Verify import identity behavior and retained assets on a disposable copy during a restore drill. A pre-migration snapshot has a defined cutoff. Reconcile work saved after that cutoff before serving the restored deployment.
