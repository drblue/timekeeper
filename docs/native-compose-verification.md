# Native Docker Compose verification

The 2026-11-14 verification uses Git revision `a649d8d586b5b2e03168e59db51651373301fcac`. The native builds on both hosts validate the same archived source against its SHA-256 manifest. The Dockerfile pins Node 24.19.0's Debian Bookworm slim multi-architecture index. Each host builds the runtime and one-shot migration targets for its native architecture.

Each test uses a disposable Compose project, private local data directory, two unused loopback ports, and a temporary local TLS proxy with an explicitly trusted test certificate. No application port is exposed publicly. The runtime uses UID/GID 1000:1000, a read-only root, dropped capabilities and a persistent bind. The migration service has no network. No production domain, proxy configuration, database or existing container is modified.

The fresh install test first expects startup to fail without migrations. It then applies all 16 migrations, provisions a synthetic account, verifies the health and readiness routes, and checks the manifest. Anonymous work access returns 401. HTTPS login verifies a secure session cookie and password hashing. The same saved entry ID, 3,600 seconds and 80,000 öre must survive restart and forced container replacement. The replacement also renders an authorized production PDF and returns a portable archive with a verified entry checksum.

The upgrade uses a separate populated database from migration 0015. A consistent backup captures a committed WAL entry. The new runtime refuses this older schema before migration. Applying migration 0016 preserves the verified entry IDs and revisions, invoice and Trash state, 121 seconds and 170 öre across three saved allocations, and tracked table counts. SQLite integrity and foreign-key checks pass before and after. The upgraded app reaches readiness through TLS.

## Native results

| Host | Native runtime | Runtime image ID | Migration image ID |
| --- | --- | --- | --- |
| Pi 4 | Linux ARM64, Node 24.19.0 | `7c4c793c3f260440552cfb33576e142626c6d8fa12ffb8e94ede05e04e4fe9bb` | `4627d2d7d65ea0d7f3cdc462639c456f35ac7337333eaedff615b4bea3431f54` |
| VPS | Linux x86-64, Node 24.19.0 | `6de7e7611ec28b84ceecb83868cb6f96fd94673b04b5a993be7f0584953378fc` | `6536548e50c9d8d0f2818563c8fe995c9bd0349fa1f00ed6ff77da283ff15544` |

Both runs passed the fresh install, restart, forced replacement and populated upgrade. Both replacement containers returned a 4,907-byte PDF and the expected archive schema. Data directories and report artifact directories had mode 0700, and databases and WAL sidecars had mode 0600. The source checksum manifest digest was `85162b87402c268dc6872b9e729aa7e63858b67323e0f86dc59d6a32338b3cdd`.

The Pi's native build reached 85.7 °C and registered thermal throttling. Docker memory limits are unavailable on this Pi. The build guard observed at least 1,701 MiB available memory. The VPS build guard observed at least 1,809 MiB, and its runtime test applied a 2 GiB container limit. Both test projects, proxies, tags and temporary data were removed. Original running container IDs, start times and states matched before and after. This rehearsal used a disposable certificate and does not configure production DNS, proxy access, backups or certificate renewal.

- [Pi results](evidence/native-compose/pi4-checks.txt) and [build telemetry](evidence/native-compose/pi4-build-samples.tsv)
- [VPS results](evidence/native-compose/vps-checks.txt) and [build telemetry](evidence/native-compose/vps-build-samples.tsv)
