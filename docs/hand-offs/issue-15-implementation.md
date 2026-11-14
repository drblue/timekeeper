# Issue 15 implementation handoff

- [GitHub issue #15](https://github.com/drblue/timekeeper/issues/15), INV-02, BILL-02, A09. Base `cab8b7d`.
- Reused GPT-6.1 Sol/high for backend, GPT-6.1 Sol/medium for browser implementation, GPT-6.1 Terra/medium for independent validation, and GPT-6 Astra/high for independent review.

## Behavior

- The bulk review offers explicit split-and-mark for eligible work that crosses the selected dates. It shows the original and proposed portions, Stockholm times, duration, exact amount, and which portions will stay uninvoiced.
- Commit uses the existing preview and retry receipt. It rechecks selection and revisions in one writer transaction and preserves the original day allocations and calculation versions, including zero-öre portions. Only the in-range child is marked.
- Superseded originals stay available as read-only detail and history and remain outside live work and Trash. Each child links to its same-account source. The original records all child IDs. Later edits to eligible child durations or rates recalculate amounts, while description-only edits preserve inherited amounts.
- Migration 0011 retains previous records and adds split lineage. Clockify identity integration will consume the retained relationship when import is implemented.

## Verification

- Implementation `d41c526`. Terra passed type checking, production build, 67 server tests, and 48 pinned Chromium tests. Independent disposable checks verified migration, one-öre conservation, a 25-hour day, inherited and recalculated amounts, lineage, injected rollback, and receipt replay.
- Desktop and phone Chromium previews and confirmations passed. Impeccable returned no findings on the changed UI.
- Astra's final 18-file manifest `13a7602b5e966b2a9e4dbaeecfe5bb2b93fac2daf4328ed515b75569551a1639` matched the staged files. No open review findings.
