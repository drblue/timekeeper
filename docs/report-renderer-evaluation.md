# Report renderer evaluation

React PDF 4.9.0 rendered the six synthetic fixtures with the expected A4 layout and report data on an Apple Silicon Mac. Keep the renderer provisional until the performance and API responsiveness runs on a physical Raspberry Pi 4 and an x86-64 host. If either target fails the layout or resource gate, evaluate HTML-to-PDF with the same report data, fixtures, and API probe, including the browser's resource use. See [technical design §9](technical-design.md#9-reports-and-provisional-react-pdf-gate).

## Reproduce the samples

Use Node.js 24.19.0, npm 11.17.0, and the committed lockfile. The renderer prototype uses React 19.3.1, React PDF 4.9.0, and TypeScript 7.0.2. Visual inspection used Poppler 26.08.0. The renderer accepts preallocated `ReportData` and produces PDF bytes. The independent fixture builder prepares the day series, project shares, summary rows and details. The fixture code is separate from the application workspaces. [React PDF Node API](https://react-pdf.org/docs/v4/node), [SVG primitives](https://react-pdf.org/docs/v4/svg).

```sh
npm ci
npm run typecheck:pdf
npm run fixture:pdf
```

The last command writes six PDFs and matching expected-data JSON files to `output/pdf/`. In the JSON, durations are integer seconds and money is integer öre serialized as decimal strings. Pass a fixture name after `--` to render that case alone. The optional second argument selects an output directory.

| Fixture | Expected total seconds | Expected total öre | Extracted total hours | Extracted amount | Pages | Main cases |
| --- | ---: | ---: | --- | --- | ---: | --- |
| `empty` | 0 | 0 | 0:00:00 | Hidden | 3 | Empty pie state, seven zero days |
| `single` | 18,000 | 625,000 | 5:00:00 | Hidden | 3 | Scoped client and project, one full pie labeled 100% |
| `no-project` | 12,645 | 439,063 | 3:30:45 | Hidden | 3 | Swedish no-project label and a full pie, directly assigned and unassigned work |
| `dense-sv` | 1,113,840 | 38,674,967 | 309:24:00 | Hidden | 8 | Swedish, logo, 53 numbered legend rows, three labeled legend continuation pages, duplicate project names, one-second share at 0,00009% |
| `detailed-en` | 10,882 | 201,213 | 3:01:22 | SEK 2,012.13 | 6 | English, logo, Swedish text, mixed rates, rounding edges, long descriptions, repeated summary and appendix headers |
| `year-large-sv` | 5,918,400 | 162,816,994 | 1 644:00:00 | 1 628 169,94 SEK | 189 | 12 monthly panels with 366 daily positions, 3,200 detailed entries over 178 appendix pages |

Hours are printed as hours:minutes:seconds. The money-enabled fixture distinguishes an explicit zero rate from non-billable work, and checks that half an öre prints as 0.01 SEK while the amount just below it prints as 0.00 SEK. Summary grouping trims surrounding whitespace and distinguishes case, project IDs, client IDs, and displayed hourly rates.

## Layout inspection

```sh
mkdir -p /tmp/timekeeper-pdf-inspect
pdfinfo output/pdf/year-large-sv.pdf
pdftotext -layout output/pdf/year-large-sv.pdf /tmp/timekeeper-pdf-inspect/year.txt
pdftotext -bbox output/pdf/year-large-sv.pdf /tmp/timekeeper-pdf-inspect/year.html
pdftoppm -f 1 -l 7 -r 120 -png output/pdf/year-large-sv.pdf /tmp/timekeeper-pdf-inspect/year
pdftoppm -f 1 -l 8 -r 120 -png output/pdf/dense-sv.pdf /tmp/timekeeper-pdf-inspect/dense
```

- Visually checked every page of the five shorter PDFs and 11 pages from the large report, including its overview, all 12 monthly panels, summary pages and pages from the beginning, middle and end of the appendix. The chart-page legend sits to the right of the vector pie, numbered legend rows continue on titled pages, zero-day positions are visible, and the logo and Swedish glyphs render.
- Used Poppler page geometry, text extraction and word bounds on all 212 pages. Each page was A4 portrait with its expected sequential page number, text inside the page margins, and a clear footer band. Table headers repeated on all summary and appendix pages.
- Compared the extracted report totals with the JSON fixture inputs. Checked all 53 numbered legend references, the 366 daily labels, and the date, client, project, description, duration, rate and amount on all 3,200 appendix rows against the expected data. Verified that both copies of the long description contain all 68 step lines and the complete 432-character token after removing visual line-wrap hyphens.
- The layout uses separate chart and table sections even for short reports. Dense projects with sub-pixel wedges remain visible by name, duration, percentage, and reference number in the legend. The standard Helvetica fonts cover the Swedish and English samples. Wider Unicode coverage and arbitrary logo dimensions were outside these fixtures.

## Local performance diagnostic

The benchmark starts the existing Fastify app on an ephemeral loopback port and polls its liveness endpoint at a target rate of 20 requests per second. Each request has a one-second timeout and must return the expected body. It measures a two-second baseline and then starts one fresh Node process at a time to render the fixture. Render time measures PDF generation from preallocated data. Worker wall time also includes process startup, fixture preparation, and local PDF and JSON writes. Peak RSS is the child process high-water mark through render completion. The probe measures local liveness under renderer CPU load, with no database workload. [Node.js process resource usage](https://nodejs.org/docs/latest-v24.x/api/process.html#processresourceusage).

```sh
npm run benchmark:pdf -- dense-sv 3 output/pdf/benchmark-dense.json
npm run benchmark:pdf -- year-large-sv 3 output/pdf/benchmark-year.json
```

Measured on 2026-11-10 at revision `7deccdfe3ffac33272f5cb2bda0258b9b4d5e316`. The host was a MacBook Pro with an Apple M1 Max (10 cores), 64 GiB RAM, and macOS 26.6.2 (`darwin/arm64`, Darwin 25.6.0). The checkout and worker temporary files were on the local APFS data volume. Codex and normal background apps were running. No other validation workload was deliberately run during the samples.

| Fixture / run | Render ms | Worker wall ms | Peak RSS MiB | Probe requests / failures | API p50 ms | API p95 ms | API max ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Dense baseline | | | | 39 / 0 | 4.83 | 8.29 | 15.09 |
| Dense 1 | 228.4 | 363.3 | 178.5 | 8 / 0 | 1.97 | 2.13 | 2.13 |
| Dense 2 | 230.5 | 365.7 | 176.8 | 8 / 0 | 1.96 | 2.03 | 2.03 |
| Dense 3 | 230.5 | 365.3 | 187.2 | 8 / 0 | 1.95 | 2.54 | 2.54 |
| Year baseline | | | | 40 / 0 | 4.52 | 8.05 | 10.76 |
| Year 1 | 4,454.9 | 4,656.1 | 668.0 | 90 / 0 | 1.96 | 2.19 | 3.17 |
| Year 2 | 4,373.2 | 4,539.7 | 661.4 | 88 / 0 | 1.92 | 2.08 | 2.49 |
| Year 3 | 4,425.4 | 4,595.1 | 663.6 | 89 / 0 | 1.93 | 2.19 | 3.23 |

An early unbatched appendix took approximately 108 seconds and reached 1.61 GiB peak RSS in a development run that overlapped other work. The current renderer lays out table rows in batches of at most 72, then wraps each batch across pages, avoiding a layout pass over all pending rows at each page break. The early run informed the batching decision. The six isolated samples above provide the local evidence for the committed prototype.

## Open hardware gate

Run both benchmark commands on the physical Pi 4 and the physical x86-64 host. Record model, process architecture, OS and Node version, available RAM, storage for the working directory and `TMPDIR`, and other active workloads. Preserve the JSON output, record time and memory under the intended deployment load, and inspect the PDFs produced on those hosts. Use those measurements to choose worker limits and decide whether to accept React PDF or evaluate the fallback. No target-host measurements were available in this evaluation.
