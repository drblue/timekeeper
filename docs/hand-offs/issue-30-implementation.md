# Issue 30 release rehearsal handoff

- [GitHub issue #30](https://github.com/drblue/timekeeper/issues/30), A01–A22. Candidate `a6f9bbfed29c5b612274f54220f4a687140762f5`. [Acceptance evidence](../release-rehearsal.md)
- GPT-6.1 Sol/medium implemented the editor display and PDF download changes and drafted the evidence matrix. GPT-6.1 Sol/high ran the supplemental A01 and A12 browser checks. GPT-6.1 Terra/medium independently validated the candidate. GPT-6 Astra/high independently reviewed the integrated source and fixes.

The compact editor displays `11500` as `1:15:00` while preserving padded zero and whole hours. Both modes retain compact focus and the same stored timing. The final review found that the PDF download link forced stale error responses to be saved. The link now uses the server's attachment response. The desktop and phone tests verify the real attachment, a simulated 410 without a file, and recovery with Back.

## Verification

- `npm run check` passed type checking, production build, 114 server tests and all 78 desktop and phone Chromium tests. The age-dependent host test was skipped and the same encrypted backup/restore operations passed with the pinned age binary in Docker. A prior overlapping build interrupted one browser login. The isolated checks passed.
- Astra found no additional blockers across authentication, offline recovery, import operation receipts, restore, deployment and reporting. The two-file fix matched the independently reviewed manifest `4a97f74dc376e0184a94096158c96eb3a26f71b1ac75ec50486219c28058ce9c`. The four-file compact input correction matched `8006889df766b5604da24b3b339de6793ea0a6c7f7f9226eba8936cfc774ffd0`.
- Separate Chrome sessions recovered a timer after a real server restart. A phone-sized workflow verified reporting and new-work choices for a renamed and archived project. Phone coverage uses emulation. Empty and single-project PDFs passed production-worker and visual checks.
- Native Pi 4 and VPS at the exact candidate revision passed clean migration, TLS sign-in, durable restart and replacement, populated upgrade and PDF checks. The Pi throttled during the rehearsal. A separate exact backup implementation rehearsal restored encrypted work on the VPS. [Native and recovery evidence](../release-rehearsal.md#final-native-rehearsal)
- The SQLite, PostgreSQL and MariaDB portability fixtures passed. Full data transfer to either optional target remains deferred.

## Remaining deployment decisions

The production HTTPS hostname and access policy, external backup destination, age key custody and recovery copy, and alert recipient remain open. The operator must verify the selected production configuration, scheduled backup, actual off-host restore and alerts before relying on it. [Deployment guide](../deployment.md) · [Backup and restore procedure](../backup-recovery.md)
