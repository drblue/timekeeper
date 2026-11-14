# Issue 21 implementation handoff

- [GitHub issue #21](https://github.com/drblue/timekeeper/issues/21), IMPORT-03, A18. Base `4475cce`.
- Reused GPT-6.1 Sol/high for backend, GPT-6.1 Sol/medium for browser implementation, GPT-6.1 Terra/medium for independent validation, and GPT-6 Astra/high for independent review.

## Behavior

- A new group of identical source rows defaults to one accepted copy. Review distinguishes saved claims, selected new copies, and omitted copies. Changing the count invalidates confirmation until a fresh review.
- Existing claims survive reordered, overlapping, and partial exports, including when the entry was moved to Trash. Choosing fewer copies does not release a claim. Choosing more assigns the lowest vacant positive slots without renumbering surviving claims.
- The preview binds the exact occupied slots and proposed additions. A concurrent change requires another review. Completed pre-multiplicity receipts still replay. The existing schema already supports occurrence slots, so no migration is needed.

## Verification

- Implementation `df433d5`. Terra independently passed type checking, the production build, 91 server tests and 70 pinned Chromium tests. Additional API checks covered invalid counts, stale reviews, reordered overlap, deleted claims, and legacy receipt replay.
- Desktop and phone Chromium confirmed the default, updated count, cancelled review, and subsequent overlapping imports. The dedicated browser fixture avoids sharing the per-account login limit with inspection tests. Impeccable returned no source findings.
- Astra's exact 12-file manifest `c0f33f72d8c5ac2b60b8601252439be7c9509285dc63775055fec28a8692a7b1` matched staging. No open review findings.
