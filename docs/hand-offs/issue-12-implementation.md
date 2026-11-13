# Issue 12 implementation handoff

- [GitHub issue #12](https://github.com/drblue/timekeeper/issues/12), ENTRY-05, IMPORT-03. Base `79cf74b`.
- Reused GPT-6.1 Sol/high for backend, GPT-6.1 Sol/medium for browser implementation, GPT-6.1 Terra/medium for independent validation, and GPT-6 Astra/high for independent review.

## Behavior

- Move to Trash requires explicit confirmation tied to a revision and an uninvoiced entry. It preserves the entry ID, saved allocations, and history. The active work scope excludes it from lists, totals, overlap, editing, and continuation.
- Trash shows recoverable work and the server's restore deadline. Restore checks the revision and deadline in the write transaction and records history. At exactly 30 days an entry is no longer restorable. Its retained row and allocations remain available for future import identity integration.
- Migration 0008 adds deletion state. Historic timer receipts retain their original response. Ordinary receipt replay does not revive deleted work. Future report and Clockify flows must keep the shared work-scope exclusion and retained tombstones.

## Verification

- Implementation `8e181c8`. Terra passed type checking, production build, 59 server tests, and 36 pinned Chromium tests. Independent disposable checks verified the populated migration, exact 30-day boundary, revision and invoice locks, retained allocations/history, and shared active-scope exclusion.
- Desktop and phone Chromium walkthroughs verified cancel, confirmation, restored entry identity, history, and focus. Astra's Impeccable source detector returned no findings on the changed UI.
- Astra's final 24-file review manifest `765d607c4323a6087f59edc8c4cd7b059729e1bedf7c70ddaffaa26bd7c3547c` matched the staged files. No outstanding findings. Report and import identity end-to-end checks await their consumers.
