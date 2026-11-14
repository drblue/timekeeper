# Issue 27 implementation handoff

- [GitHub issue #27](https://github.com/drblue/timekeeper/issues/27), OPS-02 and A22. Base `3a85698`, backup implementation `de98546`, operator guide and systemd units `def2892`.
- GPT-6.1 Sol/high implemented backup and recovery. GPT-6.1 Sol/medium wrote the operator documentation. GPT-6.1 Terra/medium independently validated it. GPT-6 Astra/high independently reviewed it.

## Behavior

SQLite's backup API captures committed WAL writes. The backup verifies migration history, integrity, exact counts and integer totals, and embedded branding. It age-encrypts the archive, verifies the published copy, then prunes expired paired backups outside the last 30 UTC dates. The destination marker and separate-filesystem check guard production publication. An exclusive destination lock prevents concurrent publication and retention. Restore verifies the archive into a new private directory, preserves durable records, and clears transient state before startup.

## Verification

- The independently reviewed 18-file SHA-256 manifest `2c61251ee966f42f8cb5f1e3838bf3f6d9f9213917b370e8b7d4423d9b3f5f15` matched the committed source and operator guide. No open review findings.
- The focused backup suite passed with pinned age 1.1.1 in native ARM64 containers. Independent validation used the final local ARM64 image with a populated database, a committed WAL write, a fresh sign-in, repeat-import checks, a wrong key, and damaged ciphertext. Type checks and build passed. The host server run passed 114 checks and skipped one age-only check. An overlapping web build interrupted one browser login in the first integrated run. The release rehearsal records the isolated combined rerun.
- The exact backup implementation ran on native Pi 4 ARM64 and VPS x86-64. The encrypted copy restored successfully with exact durable records and repeat-import behavior. Existing services matched their pretest state. [Native restore verification](../backup-restore-verification.md)
- Production external mount, key custody and recovery copy, failure/staleness alerts, and the rehearsal using those actual settings remain part of the release gate. [Backup and restore procedure](../backup-recovery.md)
