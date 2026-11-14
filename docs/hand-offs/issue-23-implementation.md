# Issue 23 implementation handoff

- [GitHub issue #23](https://github.com/drblue/timekeeper/issues/23), IMPORT-04, A20. Base `8088def`.
- Reused GPT-6.1 Sol/high for backend, GPT-6.1 Sol/medium for browser implementation, GPT-6.1 Terra/medium for independent validation, and GPT-6 Astra/high for independent review.

## Behavior

- Import history previews the exact entries to trash or revert and any blockers. Confirmation revalidates the reviewed digest. Later revisions, invoice actions, splits, deletions or dependent correction aliases block the batch. A correction reversal increments the entry revision, so an earlier batch remains stale.
- Undo atomically trashes unchanged created work, restores exact prior correction values and allocation calculation versions, releases batch claims, and records history and a durable receipt. Client and project records and initial invoice marks are retained.
- Migration 0016 adds undo metadata and archived source identities. Ordinary Trash restoration reacquires the released occurrence if it is free. A reimported replacement blocks restoration of the original. Successful undo responses replay with the original key.

## Verification

- Implementation `af71813`. Terra independently passed type checking, the production build, 104 server tests and 74 pinned Chromium tests. Additional probes covered populated migration, exact allocations, initial invoice preservation, rollback, stale revisions, receipt replay and restore/reimport ordering.
- Desktop and phone Chromium verified review and cancel, current and restored Stockholm clock intervals, retry after lost confirmation, and preserved invoice status in Trash. Impeccable returned no source findings.
- Astra's exact 25-file manifest `42b560c63beb77b7bf7d569e33ea9c412c4c0cc420eebbe64b8252b1717c68d4` matched staging. The exact-interval finding was fixed and revalidated. The author measured a local 4,000-entry undo at 2.95 s. No open review findings.
