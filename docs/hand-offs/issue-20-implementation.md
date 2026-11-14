# Issue 20 implementation handoff

- [GitHub issue #20](https://github.com/drblue/timekeeper/issues/20), IMPORT-02–04. Base `e1caf08`.
- Reused GPT-6.1 Sol/high for backend, GPT-6.1 Sol/medium for browser implementation, GPT-6.1 Terra/medium for independent validation, and GPT-6 Astra/high for independent review.

## Behavior

- A staged export supports catalog matches and approved creation, bulk and per-row historical rates, explicit non-billability, DST and duration choices, incomplete approval, and exclusion. The final review uses the server's exact planned rows and distinguishes same-name catalog IDs and new records. Current catalog defaults remain intact.
- Confirmation rechecks the immutable reviewed plan under the account writer lock. Catalog, entries, exact allocations, histories, batch, source claims, and receipt commit together. The original idempotency key recovers a confirmed result after reload or stage expiry.
- Source claims survive reorder, rename, overlapping export windows, local edits, trash, and split. Initial invoiced incomplete entries retain the source mark and can be unmarked for completion. The next tickets add multiplicity, correction resolution, and undo.
- Migration 0014 adds account-scoped stages, previews, batches, and identity claims. Source snapshots have access expiry, and later staging purges expired snapshots. Duration-only import requires complete fields. The author measured a 4,000-row commit at 2.78 s on local SQLite. The Pi maximum was not measured.

## Verification

- Implementation `caa8f14`. Terra independently passed type checking, the production build, 89 server tests and 68 pinned Chromium tests. A populated migration and isolated API suite verified 29 entries and 12 invoices, reordered and overlapping exports, exact zero/missing rate handling, stale review, atomic rollback, and durable replay.
- Desktop and phone Chromium verified file staging, mapping, approval, same-name catalogs, and retry after a lost confirmation response. Impeccable returned no source findings.
- Astra's exact 28-file manifest `0ecac769b92a9a427ca83ece07fd9b4eeede91749e7ad48f0ce5d9afe00b216c` matched staging. No open review findings.
