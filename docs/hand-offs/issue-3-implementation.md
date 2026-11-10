# Issue 3 implementation handoff

- Ticket [#3, Evaluate PDF layout and resource use](https://github.com/drblue/timekeeper/issues/3)
- Branch `dev`, base `3a5170a`, implementation revision `7deccdfe3ffac33272f5cb2bda0258b9b4d5e316`
- Implementation model `gpt-6.1-sol`, high reasoning

## Accepted outcome

On 2026-11-10 the user accepted pdfmake 0.3.14 for production time reports based on the independent layout validation and resource measurements on the physical ARM64 Pi 4 and the intended x86-64 KVM VPS under Docker. The VPS comparison evidence is at revision `e5b8662`. The production adapter, dependency, worker limits and end-to-end job checks belong to [issue #18](https://github.com/drblue/timekeeper/issues/18). [Renderer decision](../adr/0002-pdfmake-for-time-reports.md)

## Baseline prototype

The prototype under `prototype/pdf/` renders six A4 samples from synthetic, preallocated `ReportData` with the pinned React PDF 4.9.0 development dependency. It includes localized labels, vector charts, a numbered legend with continuation, repeated table headings and page numbers, exact money and duration formatting, and a 3,200-entry appendix. A separate benchmark measures an isolated renderer process while the existing API answers loopback liveness requests. Production report queries, jobs and downloads remain in the follow-up tickets.

See the [renderer evaluation](../report-renderer-evaluation.md) for commands, expected and extracted totals, page inspection, and all six fresh-process measurements. `npm run typecheck:pdf` and `npm run fixture:pdf` passed. `PLAYWRIGHT_BROWSERS_PATH=/private/tmp/timekeeper-playwright npm run check` passed the app type checks, six API tests, production build, and four Chromium tests. The generated PDFs and their expected data are under `output/pdf/`, with benchmark logs in `benchmark-mac-dense.json` and `benchmark-mac-year.json` in that directory.

## Independent checks of the baseline

- **Validation — gpt-6.1-terra, high reasoning:** independently inspected contact sheets across all six fixtures and representative full-size pages; found no clipping/overlap. Checked text page bounds, numbering and relevant repeated headers across all 212 pages, reconciled durations for every fixture and monetary totals for both money-enabled reports. Reran PDF type checking/build and generated a separate detailed report with the expected six pages, 3:01:22 and SEK 2,012.13. The large report received representative image review and document-wide text checks, not visual inspection of every page.
- **Code review — gpt-6-astra, high reasoning:** approved code `7deccdfe3ffac33272f5cb2bda0258b9b4d5e316` with no actionable findings. Independently compared all 3,200 appendix rows in order and checked headings on all 178 appendix pages, plus exact money formatting beyond JavaScript's safe integer range.
- **Documentation review — gpt-6-astra, high reasoning:** approved evaluation revision `fa81986d18ce387ba36776dacdb505a1aa7ae9b7`; benchmark tables match measured JSON and accurately limit conclusions to the tested Mac workload.

## Physical Pi follow-up

At the user's request, the same renderer revision was deployed temporarily to the physical Pi 4 at 192.168.1.6. The three dense and three large-report runs succeeded; target outputs passed independent validation. Sol (high reasoning) executed the isolated benchmark, Terra (high reasoning) checked the fetched outputs, and Astra (high reasoning) reviewed metrics and reporting. See the updated [evaluation](../report-renderer-evaluation.md) and raw evidence for the active-throttling conditions, measurements and confirmed cleanup.

## Alternative renderer comparison

At the user's request, Sol/high agents implemented pdfmake and sandboxed HTML/Chromium prototypes plus a shared fresh-worker benchmark at f6373a1; cancellation cleanup was fixed in 2f20337 after Astra/high review. Terra/high independently validated all 18 Pi PDFs, and Astra/high checked code and measurement reporting. See [the comparison](../pdf-renderer-comparison.md) for complete measurements, the thermal stop and recovered single-run annual comparison, target output provenance and confirmed cleanup.

## VPS Docker follow-up

The user-authorized Docker comparison on bob.haxx0r.org completed all three suites with three runs per renderer at ddc7184 (renderer/harness unchanged from 2f20337). All 1,041 liveness probes succeeded. Terra/high independently validated all 18 PDFs; Astra/high reviewed isolation and reporting. See [VPS results](../pdf-renderer-vps-comparison.md) for quotas, memory accounting, build-monitoring limitation, raw evidence and cleanup.
