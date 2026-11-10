# Report renderer evaluation

A subsequent [comparison of pdfmake and HTML/Chromium](pdf-renderer-comparison.md) evaluates alternatives on the same Pi, including the actual six-page workload. The 92–109 second results below are for the 189-page annual report.

React PDF 4.9.0 rendered the six synthetic fixtures with the expected A4 layout and report data on an Apple Silicon Mac and a physical Raspberry Pi 4. Pi measurements are recorded below. Keep the renderer provisional pending physical x86-64 measurements and the final resource-budget decision. If either target fails the layout or resource gate, evaluate HTML-to-PDF with the same report data, fixtures, and API probe, including the browser's resource use. See [technical design §9](technical-design.md#9-reports-and-provisional-react-pdf-gate).

## Reproduce the samples

Use Node.js 24.19.0, npm 11.17.0, and the committed lockfile. The renderer prototype uses React 19.3.1, React PDF 4.9.0, and TypeScript 7.0.2. Visual inspection used Poppler 26.08.0. The renderer accepts preallocated `ReportData` and produces PDF bytes. The independent fixture builder prepares the day series, project shares, summary rows and details. The fixture code is separate from the application workspaces. [React PDF Node API](https://react-pdf.org/docs/v4/node), [SVG primitives](https://react-pdf.org/docs/v4/svg).

```sh
npm ci
npm run build -w @timekeeper/contracts
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

## Physical Raspberry Pi 4 measurement

Measured on 2026-11-10 at the same renderer revision `7deccdfe3ffac33272f5cb2bda0258b9b4d5e316`, on the user-authorized Pi at 192.168.1.6. It is a Raspberry Pi 4 Model B Rev 1.1 with four Cortex-A72 cores and 4 GB RAM (3,886,780 KiB reported by Linux), running Debian 13 and kernel `6.12.75+rpt-rpi-v8` in native ARM64 mode. An isolated, checksum-verified Node 24.19.0 runtime supplied npm 11.17.0. The installed system runtime was not replaced.

The source archive and lockfile were verified after transfer. The temporary checkout, npm cache and renderer TMPDIR used the ext4 USB-attached `/dev/sda2` filesystem, not RAM-backed `/tmp`. Setup used nice 10; benchmarks ran at nice 0 on all four CPUs with the existing ondemand governor. Seven existing containers and other background processes remained active. These are measurements under that host's operating conditions, not an otherwise-idle controlled hardware comparison.

A fresh checkout exposed a missing prerequisite in the earlier reproduction instructions: build the shared contracts before compiling the PDF prototype. The command above now includes that step. The benchmark source was not changed for the Pi run.

Raw evidence: [dense measurements](evidence/pdf-pi4/benchmark-dense.json), [year measurements](evidence/pdf-pi4/benchmark-year.json), [before](evidence/pdf-pi4/host-before.txt), [after](evidence/pdf-pi4/host-after.txt), and [sampled host telemetry](evidence/pdf-pi4/host-samples.tsv).

| Fixture / run | Render seconds | Worker wall seconds | Peak worker RSS MiB | Probe requests / failures | API p95 ms | API max ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Dense baseline | | | | 41 / 0 | 12.51 | 15.12 |
| Dense 1 | 3.169 | 4.498 | 182.6 | 90 / 0 | 13.61 | 18.12 |
| Dense 2 | 3.908 | 4.946 | 182.9 | 99 / 0 | 18.34 | 32.63 |
| Dense 3 | 4.229 | 5.663 | 183.0 | 112 / 0 | 23.52 | 54.90 |
| Year baseline | | | | 41 / 0 | 15.16 | 18.83 |
| Year 1 | 92.426 | 93.988 | 594.9 | 1878 / 0 | 11.02 | 57.67 |
| Year 2 | 98.674 | 100.341 | 633.0 | 2006 / 0 | 8.74 | 75.33 |
| Year 3 | 108.556 | 110.880 | 656.5 | 2216 / 0 | 9.89 | 102.01 |

All 6,483 liveness probes succeeded (82 baseline, 301 during dense workers, 6,100 during year workers). RSS is the renderer child process high-water mark sampled through render completion, not combined application/OS memory. Worker wall time includes startup and output writes. Liveness has no database workload, so these results do not establish full application latency under production load.

### Thermal and memory conditions

The pre-benchmark snapshot was already 81.8°C with historical throttling flags. During dense render samples temperatures were 83.263–86.185°C; year render samples were 83.750–87.159°C. Current frequency-cap/throttling bits (`0x6`) and current soft-temperature-limit bits (`0x8`) were observed in both workloads; high bits also retained history. The Pi therefore did not run in a cool, unthrottled steady state. These readings establish the conditions, but cannot quantify how much faster different cooling would make the renderer. See the official [flag definitions](https://www.raspberrypi.com/documentation/computers/os.html#get_throttled).

Minimum sampled available memory during the year render phase was 1,170.2 MiB. System-wide swap counters across before/after benchmark snapshots increased by 716 pages in and 4,151 pages out (2.80 MiB and 16.21 MiB with 4 KiB pages). These are whole-host counters and cannot be attributed solely to the PDF worker. A guard would stop the test at 88°C or below 256 MiB available; it did not trigger. The native render results support asynchronous generation with one worker as designed; they do not support promising interactive-speed generation of the 3,200-row report on this host.

### Target output and cleanup

The first successfully completed measured year worker supplied the retained 189-page target PDF. The five shorter fixture PDFs were generated separately on the Pi. They are available locally under `output/pdf/pi4/`; their [checksums](evidence/pdf-pi4/fixtures.sha256) were verified after transfer. All six expected-data JSON files and all six extracted PDF layout texts match the Mac outputs.

Independent validation with gpt-6.1-terra (high reasoning) checked A4 geometry, text bounds and sequential numbering across the target outputs, reconciled the 3,200 year detail rows and totals, and inspected representative rendered images including long text, legend continuation, empty/100% pies and the last appendix page. No clipping or overlap was observed in those images. This was not a visual inspection of every page or a guarantee of every vector graphic's bounds.

The temporary directory containing the isolated runtime and checkout was removed after fetching the evidence. [Cleanup verification](evidence/pdf-pi4/cleanup.txt) found no processes rooted in that temporary directory and confirmed the seven pre-existing containers remained running. No system runtime, cooling configuration, or existing service configuration was changed.

## Remaining hardware gate

The physical Pi 4 run is complete and its thermal limitations are documented. The physical x86-64 benchmark and target-output inspection remain open. Run both benchmark commands there and record model, architecture, OS, runtime, available RAM, storage, other workloads and raw JSON. Use that evidence alongside the Pi results to set production worker limits and make the final renderer decision. React PDF remains provisional; successful local and Pi runs do not close issue #3 by themselves.
