# Issue 13 implementation handoff

- [GitHub issue #13](https://github.com/drblue/timekeeper/issues/13), INV-01, A11. Base `c6d892b`.
- Reused GPT-6.1 Sol/high for backend, GPT-6.1 Sol/medium for browser implementation, GPT-6.1 Terra/medium for independent validation, and GPT-6 Astra/high for independent review.

## Behavior

- Individual marking shows the whole entry's count, duration, and amount before confirmation. Only active, completed billable work can be marked. Optional invoice number, invoice date, and reference are separate from the server's marking time.
- Invoice numbers are text and can be shared. Metadata correction keeps the work and original marking time intact. Explicit unmark clears live metadata and preserves the previous values in history. Already-marked incomplete work can be unmarked and then completed.
- Writes check revision and owner and record history in the same transaction. Invoiced work details and deletion stay locked. Migration 0009 adds the optional date and reference and preserves existing invoice marks.

## Verification

- Implementation `bffba02`. Terra passed type checking, production build, 61 server tests, and 40 pinned Chromium tests. Independent disposable checks covered a populated migration, eligibility, shared invoice numbers, date and marking-time separation, unmarking, and unchanged allocations. The legacy integer timestamp case also passed after the fix.
- Desktop and phone Chromium checks covered whole-entry review, metadata correction, unmark, focus recovery, and history. Impeccable reported no findings on changed UI files.
- Astra's final 17-file review manifest `82f24b7fc210c11c274a75ee934fe58eeef5866d8412a5e7b12b66d6532eee88` matched the staged files. No open review findings remain.
