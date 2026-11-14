# Issue 24 implementation handoff

- [GitHub issue #24](https://github.com/drblue/timekeeper/issues/24), OPS-03. Base `44d151e`.
- Reused GPT-6.1 Sol/high for backend, GPT-6.1 Sol/medium for browser implementation, GPT-6.1 Terra/medium for independent validation, and GPT-6 Astra/high for independent review.

## Behavior

- Entries links to scoped exports and restores its filters and focus on return. CSV writes each saved completed day allocation within the selected date/filter scope, across all pages and in Entries order. Integer seconds and öre stay exact. Spreadsheet-safe text quoting and formula protection are documented.
- The gzip-compressed UTF-8 NDJSON archive preserves durable work, relationships, histories, timer, settings and assets, and import identities, aliases and undo records. A terminal manifest records versions, counts and exact per-section SHA-256 digests. The portable export omits login/session secrets and retry receipts.
- Both downloads are owner-authorized and stream from a bounded, unlinked private spool after the SQLite snapshot finishes. Successful attachments use the browser download manager. HTTP failures remain visible as API responses and browser Back returns to the export flow. No schema migration or production dependency was added.

## Verification

- Implementation `b4882f9`. Terra independently passed type checking, the production build, 108 server tests and 76 pinned Chromium tests. Independent archives verified section checksums, exact numbers, legacy batch and real alias/undo records, nested sanitization and failure on an unsupported snapshot.
- Desktop and phone Chromium verified real CSV and gzip downloads, clipped allocation seconds/öre, safe spreadsheet text, preserved filter/focus state and error navigation without a misleading download. Impeccable returned no source findings.
- Astra's exact 20-file manifest `4ee92c697ae6818523414cc28e8b7d25544dac56887971b378c4317f90497f55` matched staging. CSV ordering and native error handling findings were fixed and revalidated. No open review findings.
