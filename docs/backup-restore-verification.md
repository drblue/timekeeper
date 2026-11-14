# Encrypted backup and restore verification

On 2026-11-14, the Pi 4 and the VPS built the backup target from the same archived revision `de9854691be8b720268025809c9d6bc673565200`. Both checked 374 files against the source manifest, whose SHA-256 was `0f9d4fc6205129784f93e214662e052c9e3f596f936ec4ae497de6d726fffaf4`.

| Host | Role | Native image ID |
| --- | --- | --- |
| Pi 4 Linux ARM64 | Snapshot and encrypt | `39fea35e0d636dde5893fe815befa1e04f298686d90375caeb0cceafba9f61bc` |
| VPS Linux x86-64 | Decrypt and restore | `f8b47b8dc042449ffc9fdd230eb6ec19fab04d58fb65c4502a55e1542198b1a7` |
| VPS Linux x86-64 | Run recovered instance | `ee50870119f38c413bd9050d11a12c01589b9ab067cf7da1568263b3b508aef6` |

The VPS generated the disposable recovery identity and sent its public recipient to the Pi. The Pi wrote an age-encrypted archive and SHA-256 sidecar to a marked private staging directory using the explicit same-filesystem test option. The coordinator streamed that pair over SSH to the VPS. Ciphertext SHA-256 matched the sidecar at both ends. The recovery identity stayed on the VPS. Both Compose operations ran without network access. This exercise used a transfer from staging. The production external mount and scheduled alert delivery still require site-specific verification.

The VPS restored into an empty private bind. SQLite integrity and foreign-key checks passed. Row hashes across 14 tables, including the migration ledger and non-secret account metadata, matched the source before and after backup. The snapshot preserved two work entries, three allocations totaling 7,200 seconds and 160,000 öre, four history rows, two invoice marks, one invoice number, a running timer, report branding and PNG bytes, three import batches, a live identity, a keep alias, a released identity, and five operation receipts. The restored database had mode `0600`. The session, report job, bulk preview, and import staging tables were empty.

After a local account reset, the recovered runtime reached readiness through isolated HTTPS. A fresh login could see the running timer, invoice number and saved branding. Import review recognized the original source and kept correction alias as already imported. A source released through undo was eligible for reimport. Both hosts removed the disposable containers, tags and staging directories. Preexisting container IDs, states and start times matched before and after. The Pi peaked at 85.2 °C during the build and reported thermal throttling. Its memory guard observed at least 1,976 MiB available.

The independent local Docker drill captured a committed SQLite change with the writer still open and a nonempty WAL. The restored durable records matched the source. Wrong identity and modified ciphertext each failed with an empty restore target. A missing destination marker preserved all previous archives. A verified copy pruned an expired pair and retained the in-window pair. The systemd example schedules 03:00 UTC daily with catch-up. The production recovery and alert route depend on the operator configuration. [Backup and restore procedure](backup-recovery.md)
