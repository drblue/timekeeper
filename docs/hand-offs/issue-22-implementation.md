# Issue 22 implementation handoff

- [GitHub issue #22](https://github.com/drblue/timekeeper/issues/22), IMPORT-03, A17. Base `8053186`.
- Reused GPT-6.1 Sol/high for backend, GPT-6.1 Sol/medium for browser implementation, GPT-6.1 Terra/medium for independent validation, and GPT-6 Astra/high for independent review.

## Behavior

- The review offers weak source-key candidates and explicit manual search when timestamps change. It shows incoming and compared source values, the current local entry, and the proposed update. Keep existing, update, and import separately each require an approved review.
- Keep and update store an alias against the original occurrence. Exact aliases replay without inflating multiplicity. Updates compare with the latest accepted source and preserve independently edited fields when the source value is unchanged. Saved associations, billability, assigned rate and invoice state stay in place.
- Update requires an unchanged active, complete, uninvoiced, unsplit target. A locked or superseded target can be kept or the incoming record imported separately. Correction proposals have row, search and allocation bounds. Migration 0015 adds owner-scoped aliases and batch snapshots preserve exact allocations with calculation versions for later undo.
- Identical active stages are reused until their original expiry.

## Verification

- Implementation `bb0b34a`. Terra independently passed type checking, the production build, 97 server tests and 72 pinned Chromium tests. Additional disposable checks covered populated migration, manual and weak source matching, saved billing and allocations, stale/locked targets, and repeated or successive aliases.
- Desktop and phone Chromium verified comparison, proposed work, explicit update, manual keep for invoiced work and repeat safety. Impeccable returned no source findings.
- Astra's exact 22-file manifest `0d5a6a676e5eef23859670a8dce1671b6384f61be28613ee557299c8059d545f` matched staging. Review findings on alias baselines, visible comparison and bounded allocation loading were fixed and revalidated. No open findings.
