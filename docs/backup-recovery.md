# Back up and restore Timekeeper

Use protected backups for service recovery. A backup contains the SQLite database, including credentials, account and work history, invoice metadata, saved allocations, settings and logo bytes, operation receipts, and Clockify import identity and undo records. The snapshot uses SQLite's backup API to include committed WAL changes. Timekeeper's portable export is intended for work-data transfer and excludes credentials. [Deployment guide](deployment.md) · [SQLite Backup API](https://www.sqlite.org/backup.html)

Before relying on production backups, choose the external destination and its access controls, identify who holds the recovery key and its separate recovery copy, and configure who receives failure and stale-backup alerts. Rehearse a restore using the selected destination and key. The following setup uses a host-mounted external filesystem, age public-key encryption and systemd on Linux.

## Prepare encryption and the destination

1. On a trusted recovery machine, generate an age identity. Store the private file with restricted access and keep a separately recoverable copy. Record who can recover it and how. Keep that identity off the application host.
2. Copy only the public recipient to the application host. Use one native age recipient per line. Verify the public key against the recovery copy before the first backup. Keep prior recovery identities until their backups have expired or been replaced and verified. During rotation, test a backup encrypted to the new recipient before retiring the previous one.
3. Mount an authenticated external filesystem on the backup host. Give UID/GID `1000:1000` access to a dedicated directory with mode `0700` and keep application data on local storage. The external filesystem must support hard links, atomic rename and file/directory synchronization. After verifying the mount is active and external, create the file `.timekeeper-backup-destination` in that dedicated directory. Its single line is the configured destination ID, using 1–128 letters, digits, dots, underscores or hyphens.
4. Leave the destination's local fallback directory without the marker. The marker lets the backup refuse a wrong or unmounted target. Confirm independently that the marked directory is on the intended external host. A marker by itself only identifies the configured directory.

On the recovery machine, for example:

```sh
umask 077
age-keygen -o timekeeper-recovery.txt
age-keygen -y timekeeper-recovery.txt > timekeeper-recipients.txt
```

Move only `timekeeper-recipients.txt` to the backup host. Protect it against replacement so new backups remain decryptable by the approved recovery identity. [age key management](https://github.com/FiloSottile/age/blob/main/doc/age.1.ronn#recipients-and-identities)

## Configure and run a backup

Build the `backup` target from the same reviewed release as the running application. Load the image on the destination architecture or publish the target alongside the app and migration images. [Deployment build options](deployment.md#build-the-images)

```sh
release=git-REPLACE_WITH_COMMIT
docker buildx build --target backup --load -t "timekeeper-backup:$release" .
```

Create `/etc/timekeeper/backup.env` from the [backup environment template](../.env.backup.example) with restricted write permissions. Use absolute host paths and replace every example value. The external path is the dedicated directory on the mounted destination. The backup checks that it is on a different filesystem from the database.

Create a private scratch directory on local storage. It holds the unencrypted snapshot while the backup runs. Use a filesystem with enough space for the database and encrypted archive together, plus room for the live database and its WAL to grow. The backup tool removes its scratch files after the run. After interruption, inspect any remaining temporary directories only while no backup is active and dispose of them as sensitive data.

```sh
sudo install -d -m 0700 -o 1000 -g 1000 /srv/timekeeper/backup-scratch
```

```dotenv
TIMEKEEPER_BACKUP_IMAGE=timekeeper-backup:git-REPLACE_WITH_COMMIT
TIMEKEEPER_DATA_DIR=/srv/timekeeper/data
TIMEKEEPER_BACKUP_DIR=/mnt/timekeeper-offhost/instance-backups
TIMEKEEPER_BACKUP_DESTINATION_ID=timekeeper-primary
TIMEKEEPER_BACKUP_RECIPIENTS=/etc/timekeeper/timekeeper-recipients.txt
TIMEKEEPER_BACKUP_SCRATCH_DIR=/srv/timekeeper/backup-scratch
```

From the release directory, validate the configuration and run once. The backup reads the live database through SQLite; keep enough storage for the snapshot and archive. Schedule away from migrations and other maintenance. For an upgrade, quiesce writers and complete a verified backup before running the migration.

```sh
docker compose --env-file /etc/timekeeper/backup.env -f compose.backup.yaml config --quiet
docker compose --env-file /etc/timekeeper/backup.env -f compose.backup.yaml run --rm --no-deps backup
```

Success prints an `ok` result with the encrypted archive basename, UTC creation time and number of old backups removed. The destination contains a `.tar.age` archive and its matching `.sha256` file. The sidecar contains the hex SHA-256 digest. The service verifies the written copy before pruning older backups and recording success. Retention covers 30 UTC calendar dates, including today. Keep any independent regulatory or long-term copies under a different retention policy. The database snapshot includes durable assets such as report branding. Generated PDF downloads are temporary and can be regenerated after recovery.

## Schedule and monitor

The [service](../ops/systemd/timekeeper-backup.service) and [timer](../ops/systemd/timekeeper-backup.timer) examples expect a release checkout at `/opt/timekeeper`, Docker at `/usr/bin/docker`, and the environment file above. Update those paths for the host. If the external mount is managed by systemd, add a drop-in with `RequiresMountsFor=/mnt/timekeeper-offhost` under `[Unit]`, using the host's actual mount path. The backup checks the destination marker at runtime, even when systemd considers the network ready. Protect the release checkout and environment file from untrusted writes because the service invokes the host Docker daemon.

```sh
sudo install -m 0644 ops/systemd/timekeeper-backup.service ops/systemd/timekeeper-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl start timekeeper-backup.service
sudo systemctl enable --now timekeeper-backup.timer
systemctl list-timers timekeeper-backup.timer
sudo journalctl -u timekeeper-backup.service -n 30 --no-pager
```

The timer runs daily at 03:00 UTC and catches up once after missed runs while the host was off. Confirm a successful remote copy before relying on the timer. Connect failed service runs to the operator's monitoring or systemd `OnFailure=` handler. Separately alert when the external destination's `.timekeeper-last-success.json` is missing, unreadable, or its `createdAt` is more than 36 hours old. Use its `file` field to identify the archive and check that the checksum sidecar is present. Check freshness from an independent host when possible so a dead scheduler or offline host still triggers a notification. Verify that the responsible person receives a test alert. [systemd timer behavior](https://freedesktop.org/software/systemd/man/latest/systemd.timer.html)

A failed run exits nonzero and reports its failing stage in the journal. Check that the external mount, marker, public recipient file, permissions, and available storage match the configuration. The destination lock `.timekeeper-backup.lock` prevents simultaneous publication. A hard interruption can leave that lock or temporary directories named `.timekeeper-backup-*` in scratch, `.timekeeper-incoming-*` in the destination, or `.timekeeper-restore-*` in a restore bind. Verify that no backup or restore process is using those paths, including processes on another host sharing the destination. Remove only the confirmed stale generated paths. After correcting the cause, start the service again and verify the new archive and checksum at the external destination.

## Rehearse a restore

Restore on a trusted machine with access to the encrypted archive and the separate recovery identity. Keep the exercise isolated from the production proxy and database. Pick the archive by its exact basename and retain the associated checksum. Keep the matching app, migration and backup images or a way to reconstruct them from the recorded release.

Create a new empty local data bind owned by the container UID/GID. Set a restricted restore environment file from the [restore environment template](../.env.restore.example) with the backup image, the private directory containing the encrypted pair, the new data directory and the separate recovery identity. Keep this file and the identity on the recovery host. The identity must be a regular file readable by UID `1000` with mode `0600` or `0400`.

```sh
sudo install -d -m 0700 -o 1000 -g 1000 /srv/timekeeper/restore-drill
```

```dotenv
TIMEKEEPER_BACKUP_IMAGE=timekeeper-backup:git-REPLACE_WITH_COMMIT
TIMEKEEPER_BACKUP_DIR=/mnt/timekeeper-offhost/instance-backups
TIMEKEEPER_RESTORE_DIR=/srv/timekeeper/restore-drill
TIMEKEEPER_BACKUP_IDENTITY=/secure/timekeeper-recovery.txt
```

```sh
backup_file=REPLACE_WITH_ARCHIVE_BASENAME.tar.age
docker compose --env-file /etc/timekeeper/restore.env -f compose.restore.yaml run --rm --no-deps restore "$backup_file"
```

The restore verifies the ciphertext checksum, decrypts the selected archive, checks the manifest against the SQLite snapshot, and places the recovered database in the empty bind. The manifest includes the application version, migration names and checksums, allocation calculation versions, record counts, exact allocation totals, and the saved logo size and checksum when present. Restore clears browser sessions, PDF jobs, bulk previews and staged Clockify imports. Durable entry and import history is preserved. Start the application separately after restoring.

Use a separate Compose project, restored data bind, matching app image and unused loopback port. Set `TIMEKEEPER_DATA_DIR` to the restored directory in a separate drill environment file. Set `TIMEKEEPER_ORIGIN` to an isolated HTTPS test origin, with a separate proxy site and trusted certificate. The example assumes an empty, unused Compose project name. Reset the recovered account password before enabling browser access.

```sh
docker compose -p timekeeper-restore-drill --env-file /etc/timekeeper/drill-app.env \
  run --rm --no-deps app node apps/server/dist/auth/operator.js reset
docker compose -p timekeeper-restore-drill --env-file /etc/timekeeper/drill-app.env \
  up -d --wait --no-deps app
```

For actual recovery, apply the [deployment rollback and restoration procedure](deployment.md#rollback-and-restoration) before sending traffic to the recovered instance.

Record the archive date, checksum and matching image digest. Compare the recovered populated instance against the expected snapshot values:

- Verify readiness, sign-in, and exact entry and allocation counts, total seconds and integer öre, including invoiced work.
- Inspect representative history, invoice metadata, rates, catalog associations, and saved report branding and logo.
- Re-run a previously imported Clockify export in review mode. Confirm that prior rows are recognized and no new work is created. Include a correction alias and an ordinarily deleted source row when available. On a disposable copy, verify an eligible import undo, then confirm released rows can be imported again.
- Record the results and test restoring from the off-host copy with the documented key-recovery procedure. Track any data saved after the chosen snapshot separately before promoting a recovered database.
