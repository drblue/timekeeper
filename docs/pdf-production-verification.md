# Production PDF verification on Pi 4 and VPS

The 2026-11-14 test used Git revision `5cce95fb5434c4ed6d17d4d68069ef51de543a49`. Each native Docker build verified the archived source, installed dependencies from the lockfile, and built the compiled server and production pdfmake adapter using Node 24.19.0 and npm 11.17.0.

The benchmark provisions a synthetic account and data in a disposable SQLite database. The client signs in, fetches the report preview, submits the PDF job, polls every 100 ms, and downloads the authenticated PDF. Three fresh jobs per fixture are measured. Health probes run roughly every 80 ms and a bounded work-list request runs on every sixth probe. Time to ready includes polling granularity. Times below are medians. The worker RSS figures are sampled peaks and can miss brief spikes.

Both runs used 1.5 CPU cores and a 128-process limit. The VPS also enforced a 2 GiB container memory limit with no extra swap. The Pi kernel does not expose Docker's memory controller. The first Pi run stopped at the capability check before rendering. The measured run kept the 384 MiB worker old-space cap and used a host guard with a 768 MiB available-memory floor, an 88 °C thermal ceiling, and a 3 GiB free-space floor. Containers ran without external networking or published ports, as nonroot, with a read-only root filesystem, dropped capabilities, and no-new-privileges. The isolated output bind held the test database and results. The temporary containers, image tags, and stage directories were removed. The original running containers matched their pretest states and start times.

| Host | Fixture | A4 pages | Accept | Ready | Download complete | Peak sampled worker RSS |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Pi 4 ARM64 | 36 entries, 31 days | 7 | 0.046 s | 2.88 s | 2.89 s | 107 MiB |
| Pi 4 ARM64 | 3,200 entries, 365 days | 200 | 0.715 s | 20.53 s | 20.55 s | 317 MiB |
| VPS x86-64 | 36 entries, 31 days | 7 | 0.019 s | 0.44 s | 0.45 s | 117 MiB |
| VPS x86-64 | 3,200 entries, 365 days | 200 | 0.140 s | 2.08 s | 2.09 s | 263 MiB |

All health and work-list probes succeeded. On the Pi, the slowest health probe took 107 ms and the slowest annual-scope work-list request took 1.72 s. The Pi reached 86.2 °C with active thermal throttling. Host available memory stayed above 1,523 MiB. On the VPS, the slowest health probe took 28 ms and the slowest annual work-list request took 270 ms. The VPS container peaked at 507 MiB across the setup and measured jobs.

Poppler confirmed A4 size and sequential page numbering on all twelve PDFs. The monthly reports contained 5:58:30 and 5 212,76 SEK. The annual reports contained 3 362:53:20 and 2 900 433,79 SEK, matching independently summed fixture amounts and the preview data. Rendered samples showed the right-hand pie legend, continuation, daily charts and appendix. PDF sizes differed slightly across architectures. The measures describe these synthetic workloads and current host conditions.

- [Pi runs](evidence/pdf-production/pi4-runs.json) and [host samples](evidence/pdf-production/pi4-host-samples.tsv)
- [VPS runs](evidence/pdf-production/vps-runs.json) and [host samples](evidence/pdf-production/vps-host-samples.tsv)
