# PDF renderer comparison on the VPS

This follow-up runs the same renderer fixtures and comparison harness as the [Pi evaluation](pdf-renderer-comparison.md) inside a temporary Docker container on the user-authorized VPS, bob.haxx0r.org. It tests x86-64 deployment under Docker on the actual intended VPS. This is a KVM virtual machine, not dedicated physical x86-64 hardware.

The source is ddc7184, whose renderer and harness code is unchanged from 2f20337. Node 24.19.0, npm 11.17.0 and the committed dependency lockfile preserve the Pi comparison versions. The workloads are the six-page detailed report, the dense 53-project report, and the 3,200-entry annual report. Each measured suite requests three fresh processes per renderer with rotating order. All six fixture PDFs per renderer are also retained for content and layout checks.

The existing harness records both render time and total worker wall time. Total time includes imports, initialization and file writes; Chromium launch and shutdown are included. The 100 ms process-tree RSS samples include Chromium descendants, can double-count shared pages and can miss transient peaks. Node high-water RSS is separate. API probes test loopback liveness with no database load.

## Environment and isolation

The VPS exposes two AMD EPYC-Genoa virtual CPUs and 3,809 MiB RAM, with Ubuntu 26.04.1, KVM and Docker 29.9.3. Five existing containers remain outside the test. A separate temporary image provides browser libraries and Liberation fonts without changing host packages.

The verified benchmark limits were 1.5 CPUs and 2 GiB RAM with no additional swap allowance. Such limits make these results deployment-specific; they must not be presented as an unrestricted hardware comparison with the Pi.

The container ran non-root with a read-only root filesystem, no network or published ports, all capabilities dropped, no-new-privileges, Docker AppArmor enforcement and a 256-task limit. Chromium's sandbox remained enabled. Its renderer had an additional seccomp filter and a nested PID namespace. The official Playwright seccomp profile received one reviewed adjustment: permitting the chroot system call without its outer capability condition, so Chromium could complete its own nested sandbox initialization. No outer capability was added.

Temporary browser profiles and benchmark intermediate files used a 512 MiB tmpfs; retained results used a bind mount on the VPS ext4 disk. The Pi benchmark used on-disk temporary storage, so storage conditions also differ. Shared host workload, virtualization and CPU quota prevent interpreting the timing ratio as a hardware-only speedup.

The initial image build had point-in-time resource/service checks but incomplete continuous monitoring: an attempted watchdog failed on a missing Docker health field. This was corrected for the cached image correction and measured run. The image correction changed source file permissions to allow the non-root user to read them. No renderer source changed.

## Measurements

Measured on 2026-11-10. Times are medians of three runs; memory ranges are sampled process-tree RSS peaks. Raw data are in [detailed](evidence/pdf-comparison-vps/benchmark-detailed.json), [dense](evidence/pdf-comparison-vps/benchmark-dense.json) and [annual](evidence/pdf-comparison-vps/benchmark-year.json).

| Workload | Renderer | Pages | Render seconds | Total worker seconds | Sampled tree RSS MiB |
| --- | --- | ---: | ---: | ---: | ---: |
| Detailed | React PDF | 6 | 0.286 | 0.566 | 152.0–162.8 |
| Detailed | pdfmake | 6 | 0.160 | 0.335 | 104.0–108.1 |
| Detailed | Chromium | 6 | 0.267 | 0.603 | 526.5–540.4 |
| Dense | React PDF | 8 | 0.434 | 0.676 | 182.9–189.3 |
| Dense | pdfmake | 7 | 0.150 | 0.306 | 90.1–102.9 |
| Dense | Chromium | 8 | 0.282 | 0.639 | 514.3–547.2 |
| Annual | React PDF | 189 | 7.967 | 8.243 | 529.6–636.2 |
| Annual | pdfmake | 156 | 1.435 | 1.632 | 234.2–244.9 |
| Annual | Chromium | 189 | 1.611 | 1.963 | 1,129.2–1,130.9 |

All 1,041 API probes succeeded (139 detailed, 140 dense, 762 annual, including baselines). Maximum observed latency was 26.513 ms. Sampled host available memory stayed at or above 1,757.2 MiB. The container's reported memory peak was 906.25 MiB, with no OOM kills. This cgroup memory figure is distinct from summed process RSS, which double-counts shared pages. The last telemetry sample reported 149 CPU-throttled periods under the quota.

These results reinforce pdfmake as the recommended candidate: lowest total time and sampled memory for each tested workload. The six-page report took about 0.34 seconds total and the full annual report about 1.63 seconds. Production integration and final acceptance remain separate; this evaluation does not change the app's renderer automatically.

## Independent validation and cleanup

Sol/high performed deployment and measurements. Terra/high independently verified the manifest and all 18 PDFs: exact annual rows and summaries, 366 day labels, 53 dense project shares, both copies of the long description, report totals, sequential page counters and text bounds. Sampled dense and detailed pages for every renderer showed no clipping or overlap. Visual inspection was sampled, not exhaustive. Chromium embedded Liberation Sans; the other renderers used standard Helvetica PDF fonts. Artifacts remain locally under `output/pdf/comparison-vps/fixtures/`.

Astra/high independently reviewed the isolation setup and measurement reporting. The code being measured was unchanged from the earlier reviewed comparison harness. The source archive, image identity, runtime versions, effective limits, exact deployment configuration and raw measurements are retained in [the evidence directory](evidence/pdf-comparison-vps/).

Cleanup removed both temporary test containers, both temporary image tags and the staging directory. The five existing containers retained their IDs, start times, restart counts and Docker health states. No host packages or service settings changed. Shared Docker build cache was retained; no broad prune was performed. Those checks establish service continuity at the container level, not application-level response-time guarantees.

The requested x86-64 VPS/Docker evaluation is complete. The earlier documentation's dedicated physical x86-64 gate is not literally met by a KVM VPS; this distinction should be resolved when accepting the renderer, rather than claiming a physical-server measurement. Issue #3 remains open and no production renderer switch is included here.
