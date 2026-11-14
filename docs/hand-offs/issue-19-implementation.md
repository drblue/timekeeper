# Issue 19 implementation handoff

- [GitHub issue #19](https://github.com/drblue/timekeeper/issues/19), IMPORT-01–02. Base `b0690e7`.
- Reused GPT-6.1 Sol/high for backend, GPT-6.1 Sol/medium for browser implementation, GPT-6.1 Terra/medium for independent validation, and GPT-6 Astra/high for independent review.

## Behavior

- From Entries, inspect a Clockify Detailed report CSV, choose a source timezone, and explicitly select a user for a multi-user export. Europe/Stockholm is the visible default. Cancel discards the selection and returns to the filtered list.
- The signed-in, CSRF-protected preview parses named columns, preserves decoded source strings including blanks, and uses exact Duration (h) seconds. It reports invalid rows, ambiguous clock times and their offset choices, nonexistent times, and timestamp/duration discrepancies.
- The raw UTF-8 CSV is limited to 4 MiB, 4,000 records, and 16 KiB per field. Structural quoting or unsupported headers reject the file, while a wrong column count identifies an invalid source row.
- Inspection is stateless. The browser keeps the selected file and results in memory until cancellation or navigation. The server creates no work records or import history. Mapping, duplicate checks, and atomic import follow in issue #20.

## Verification

- Implementation `7e3e8dc`. Terra independently passed type checking, the production build, 82 server tests and 62 pinned Chromium tests. The synthetic API corpus verified authentication, CSRF, UTF-8/BOM, raw metadata, quoted records, exact durations, timezone and user selection, and no work writes. The 4,000-row limit passed locally and oversized inputs were rejected.
- Desktop and 390 px phone Chromium verified the real file picker flow, timezone/user choices, row details and cancellation with list context and focus restored. Impeccable returned no source findings.
- Astra's exact 15-file manifest `bc27a900ca7b28df9902cc13adcba2ed929443ec3dc43af2228d7d6ba690d3b5` matched staging. Independent roundtrips and clock-change probes also passed. No open review findings.
