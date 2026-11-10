# PDF renderer alternatives

The earlier 92–109 second Pi measurement was for the 189-page, 3,200-entry annual report, not the six-page detailed report. This comparison measures both workloads explicitly, plus the dense 53-project report. The renderer remains provisional pending the comparison gates and the physical x86-64 test.

## Candidates and method

- React PDF 4.9.0 is the existing baseline.
- pdfmake 0.3.14 uses a declarative document definition, table pagination and vector SVG charts without a browser. Its dependency is development-only in this prototype. See the [official server API](https://pdfmake.github.io/docs/0.3/getting-started/server-side/methods/).
- HTML/CSS through Playwright 1.65.0 and Chromium 158.0.8127.18 uses print layout and vector SVG charts. Browser sandboxing remains enabled; JavaScript, network resources and service workers are disabled. See [Playwright PDF generation](https://playwright.dev/docs/api/class-page#page-pdf).

All three consume the same synthetic ReportData fixtures. The detailed/dense suites use three fresh workers per renderer and rotate the first renderer each round. The later annual alternative suite uses one worker per renderer. Both measure a live API on an ephemeral loopback port. Total worker wall time includes process startup, module imports, fixture preparation, rendering and PDF/JSON writes. Inner render time excludes imports; Chromium launch and shutdown remain inside it. These are fresh-process measurements with ordinary OS caches, not cleared-cache cold-boot measurements or a warm persistent browser pool.

Memory records the Node high-water mark separately from the largest simultaneous sum of worker and descendant RSS sampled every 100 ms. Use the latter for comparisons involving Chromium. Shared memory can be counted in multiple processes and short peaks can be missed; it is neither unique physical memory nor the combined application footprint. The API probe measures liveness without database traffic.

## Reproduction

```sh
npm ci
npm run build -w @timekeeper/contracts
npm run typecheck:pdf
npm run pdf:comparison:render -- all all output/pdf/comparison
npm run pdf:comparison:benchmark -- detailed-en 3 output/pdf/comparison/benchmark-detailed.json
npm run pdf:comparison:benchmark -- dense-sv 3 output/pdf/comparison/benchmark-dense.json
npm run pdf:comparison:benchmark -- year-large-sv 3 output/pdf/comparison/benchmark-year.json
```

Chromium requires a compatible installed Playwright browser and OS libraries/fonts. Use PLAYWRIGHT_BROWSERS_PATH or PDF_CHROMIUM_EXECUTABLE_PATH to select it. The Pi test privately unpacked missing libraries and Liberation fonts and selected them through LD_LIBRARY_PATH and FONTCONFIG_FILE; it did not install system packages. A production container must explicitly provide those dependencies and fonts. pdfmake uses the standard Helvetica PDF fonts for these English/Swedish fixtures; broader character coverage still requires font work.

## Correctness and review

Implementation used gpt-6.1-sol with high reasoning. Independent local validation used gpt-6.1-terra with high reasoning; code review used gpt-6-astra with high reasoning. All six local fixtures passed content checks, including all 3,200 annual detail rows, summaries, 366 daily labels, 53 legend entries, exact amounts/durations and both full copies of the long description. Representative raster inspections found no clipping or overlap. This was not visual inspection of every annual page.

Local page counts for React PDF / pdfmake / Chromium are 3/3/3 for each of empty, single and no-project; 8/7/8 for dense; 6/6/6 for detailed; and 189/156/189 for annual. The shorter pdfmake pagination retains all rows.

The reviewed prototype is f6373a1, followed by cancellation cleanup fix 2f20337. The review finding about detached workers surviving interruption is resolved. Author smoke tests confirmed SIGINT and SIGTERM stop active workers and remove temporary benchmark files. Independent source review passed; independent runtime cancellation testing was unavailable because process-list access was restricted.

## Physical Pi results

Measured on 2026-11-10 at 2f20337 on the same physical Pi 4 described in the [baseline evaluation](report-renderer-evaluation.md#physical-raspberry-pi-4-measurement), with Node 24.19.0 and the existing services running. The source checksum manifest was verified before building. Raw [six-page measurements](evidence/pdf-comparison-pi4/benchmark-detailed.json), [dense measurements](evidence/pdf-comparison-pi4/benchmark-dense.json), [runtime](evidence/pdf-comparison-pi4/runtime.txt) and [telemetry](evidence/pdf-comparison-pi4/host-samples.tsv) are retained.

The host was already about 82.7°C before benchmarking, and active thermal-limit/throttling flags occurred during the small-report suites as well as the annual test. These are hot, shared-host measurements, not unthrottled Pi capacity. Rotating order reduces but does not remove changing thermal conditions.

Times below are medians of three runs; memory is the range of sampled process-tree peaks.

| Workload | Renderer | Pages | Render seconds | Total worker seconds | Sampled tree RSS MiB |
| --- | --- | ---: | ---: | ---: | ---: |
| Detailed | React PDF | 6 | 2.814 | 4.156 | 145.3–152.3 |
| Detailed | pdfmake | 6 | 1.571 | 2.275 | 105.8–107.4 |
| Detailed | Chromium | 6 | 1.816 | 4.213 | 550.1–554.4 |
| Dense | React PDF | 8 | 5.502 | 7.199 | 165.1–186.3 |
| Dense | pdfmake | 7 | 1.642 | 2.694 | 101.9–104.4 |
| Dense | Chromium | 8 | 2.112 | 4.804 | 557.0–558.4 |

All 1,574 liveness probes succeeded across those two suites, including their baselines. These measurements favor pdfmake for the tested small reports: about 45% less total time for the six-page case and 63% less for the dense case. Chromium's browser startup reduces its advantage in rendering time, and its sampled process-tree RSS is much larger. A persistent browser could amortize startup, but was not measured and would retain resources between jobs.

The repeated annual suite was stopped by the thermal guard at 88.133°C during the second React PDF worker. Available memory was approximately 1,624 MiB. No completed annual timing JSON was produced, so partial file timestamps are not reported as benchmark timings. Completed annual PDFs from all three renderers were preserved: 189/156/189 pages with all 3,200 rows. The prior 92–109 second React PDF annual measurements remain historical evidence under different thermal conditions, not a directly paired comparison with this run.

After the host cooled to 82.776°C, a separate **single run per alternative** completed. React PDF was not repeated. [Raw annual alternative results](evidence/pdf-comparison-pi4/benchmark-year-alternatives.json):

| Renderer | Pages | Render seconds | Total worker seconds | Sampled tree RSS MiB |
| --- | ---: | ---: | ---: | ---: |
| pdfmake | 156 | 17.924 | 18.789 | 306.8 |
| Chromium | 189 | 24.126 | 27.124 | 1,051.5 |

All 936 probes including baseline succeeded; maximum latency was 69.46 ms. Peak temperature was 87.159°C and minimum available memory was 1,353.8 MiB. Whole-host swap counters did not increase in this phase. These single samples support the direction of the small-report result, but do not establish variance or a precise speedup over React PDF.

## Recommendation

Prefer **pdfmake as the next renderer candidate** for this app. It has the best measured total time and memory use of the tested alternatives, preserves the complete fixture data, and avoids browser deployment dependencies. Keep the ReportData boundary so this choice does not affect reporting calculations or data access. HTML/Chromium remains a viable alternative if future requirements demand HTML/CSS layout fidelity, but its measured resource use is harder to justify on this Pi.

This is an evaluation recommendation, not production integration or final acceptance. The physical x86-64 gate remains open, along with setting production worker budgets and checking fonts beyond the English/Swedish fixtures. The React PDF production choice has not been silently replaced.

## Target validation and cleanup

Independent Terra validation passed all 18 target PDFs: complete rows and summaries, dates, chart labels, project shares, totals, long descriptions, sequential page counters and page text bounds. Sampled target chart/table/legend/long-text rasters showed no clipping or overlap. Chromium embedded Liberation Sans on the Pi; the other renderers used standard Helvetica PDF fonts. The five shorter React PDF PDFs were reused from the prior Pi run after verifying their renderer/fixture code was unchanged; the annual React PDF and all alternative outputs came from this comparison. PDF artifacts are retained locally under `output/pdf/comparison-pi4/`, with checksums in the evidence directory.

The independently reviewed source has no outstanding blocking findings. Local application and PDF type checks passed. This prototype-only change did not modify production report behavior. Independent validation and review used different models from the implementation authors, as required.

[Cleanup verification](evidence/pdf-comparison-pi4/cleanup.txt) confirms no processes remained rooted in the isolated installation, its temporary directory was removed, and the same seven existing containers remained running. System packages, services and cooling settings were unchanged.
