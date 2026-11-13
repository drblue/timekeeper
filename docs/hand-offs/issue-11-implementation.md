# Issue 11 implementation handoff

- [GitHub issue #11](https://github.com/drblue/timekeeper/issues/11), UI-02, LIST-01, A10. Base `cd828b8`.
- Reused GPT-6.1 Sol/high for backend, GPT-6.1 Sol/medium for browser implementation, GPT-6.1 Terra/medium for independent validation, and GPT-6 Astra/high for independent review.

## Behavior

- The work list opens the current Stockholm Monday–Sunday week. Date shortcuts and custom dates combine with client, project, invoice, billability, and literal search. Archived associations remain selectable for historical work. Incompatible client and project filters explain the empty result.
- Completed work is grouped by calendar day. Each row uses its stored allocation, including partial days for entries across midnight. Totals use all matching rows across pages with exact integer arithmetic. The timer and incomplete work remain separate.
- Filters, sort, and page are encoded in the URL. Returning from an entry restores the original dates and row position through the explicit Back link. Refreshing results takes precedence over restoring focus to a stale row. Browser Back to a relative preset can recalculate its dates after a calendar rollover.
- Migration 0007 adds invoice-number storage and query indexes. Invoice marking is a later ticket. Trash exclusion is added when issue #12 introduces deletion state. The shared work-scope query is available for reporting.

## Verification

- Implementation `12f6332`. Terra passed type checking, production build, 55 server tests, and 32 pinned Chromium tests. Independent API and migration checks covered the current Stockholm week, midnight portions, exact all-page totals, literal searches, archived filters, and preservation of existing data and invoice marks.
- Desktop and phone Chromium checks verified filters, sort, page, and row position through editing and return, plus safe focus fallback when a row disappears. Impeccable reported no findings on the changed list and filter UI.
- Astra's 21-file review manifest `e2f27002b5144cf45db46c94ce9cdf01f8f5d2e3c0bc92753bba816afea16cc2` matched the staged files. The range and focus findings were fixed and rechecked. No open review findings remain.
