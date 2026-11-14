# Issue 18 implementation handoff

- [GitHub issue #18](https://github.com/drblue/timekeeper/issues/18), PDF-01–04, A14–A15. Base `4356d38`.
- Reused GPT-6.1 Sol/high for backend, GPT-6.1 Sol/medium for browser implementation, GPT-6.1 Terra/medium for independent validation, and GPT-6 Astra/high for independent review.

## Behavior

- A report captures the selected scope, exact work allocations and rates, presentation options, and private branding once. The shared pdfmake 0.3.14 adapter renders A4 output in an isolated child process. Migration 0013 stores job status and pending snapshots.
- The report preview shows status and keeps the original job scope through filter changes and reload. Completed PDF downloads require the job owner's session. Failed jobs can be requested again with their original selection.
- One server and one PDF scheduler may open each SQLite database. The scheduler runs one child at a time. It requeues interrupted jobs, retries transient terminal-state publication, and removes expired artifacts. Bounds and configuration are documented in the technical design.
- The 3,200-entry check exposed a SQLite bind-variable limit in the report preview. Shared allocation reads and bulk selection now page or batch their relation queries. Regression coverage verifies report/list parity and ordered explicit and all-matching selections.

## Verification

- Implementation `5cce95f`. Terra independently passed type checking, the production build, 76 server tests and 58 pinned Chromium tests. Additional checks covered populated migration, ownership, immutable snapshots, graceful restart, real worker timeout, cleanup and expiry.
- Desktop and phone Chromium verified real PDF generation and authorized download, an earlier selection staying pinned, reload and error recovery. Poppler extraction and raster inspection covered A4 layout, right-hand pie legend and continuation, monthly daily bars, detailed tables, totals, labels and page numbers.
- Astra's final 41-file manifest `46c953378cd1d6769a08777c1dcf89cc2eb72564728a58762054d723ec07b6be` matched the staged files. Independent probes verified exact amounts beyond JavaScript's safe integer range, timeout and output limits. Impeccable returned no findings.
- Both target hosts ran the exact production revision inside temporary containers. [Production PDF measurements](../pdf-production-verification.md)
