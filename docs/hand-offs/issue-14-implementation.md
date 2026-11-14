# Issue 14 implementation handoff

- [GitHub issue #14](https://github.com/drblue/timekeeper/issues/14), INV-01–02, LIST-01, ENTRY-05. Base `bffa5bd`.
- Reused GPT-6.1 Sol/high for backend, GPT-6.1 Sol/medium for browser implementation, GPT-6.1 Terra/medium for independent validation, and GPT-6 Astra/high for independent review.

## Behavior

- Explicit selection spans pages and deduplicates timed entries that appear on multiple days. Select all matching is bound to the reviewed filter scope. The preview shows whole-entry count, duration, known billable amount, metadata, and blockers. An unknown amount is distinguished from zero.
- An account-scoped preview retains exact IDs, revisions, filter scope, and invoice metadata for 15 minutes. Commit rechecks membership, versions, eligibility, and marking boundaries inside one writer transaction. A changed result requires renewed review. Outside-range marking is blocked pending issue #15.
- Mark, unmark, and Trash share existing mutation and history logic. Durable operation receipts replay confirmed commits without applying them again, even after a preview expires. The browser keeps the confirmed key across a same-tab reload and retains editable metadata after stale review. Delayed preview responses from an old filter scope cannot reopen confirmation.
- Migration 0010 adds preview storage. The common receipt helper preserves earlier timer request hashes and results.

## Verification

- Implementation `5ba4d46`. Terra passed type checking, production build, 65 server tests, and 46 pinned Chromium tests. Independent disposable checks verified populated migration, all-pages deduplication, stale membership and revisions, cross-account token rejection, expiry, receipt replay, and injected rollback.
- Desktop and phone Chromium walkthroughs covered selection, cancellation, exact preview, metadata recovery, and retry after a lost confirmation. A test timing failure was fixed by waiting for its selection control to be enabled before pressing Enter. Impeccable reported no findings on changed UI files.
- Astra's final 27-file manifest `d4cd3ea09cd3ccdfccde702cadfc1e3163c8f42a2cac3961f0a226f398a65917` matched the staged files. No open review findings remain.
