# Use pdfmake for server-side time reports

Status: accepted — 2026-11-10

Use pdfmake 0.3.14 to generate PDF bytes from immutable `ReportData`. It preserved the required A4 layout and complete data in the evaluated fixtures. It used the least sampled process-tree memory and had the shortest total worker times in each completed three-renderer workload. Its vector charts and table pagination run without a browser. React PDF and HTML/Chromium remain available in the comparison prototypes. [Pi comparison](../pdf-renderer-comparison.md), [VPS comparison](../pdf-renderer-vps-comparison.md)

The user accepted the physical ARM64 Pi 4 and the intended x86-64 KVM VPS under Docker as the target environments for the renderer evaluation. On the thermally throttled Pi, the six-page report took a median 2.275 seconds total with 105.8–107.4 MiB sampled process-tree RSS, versus 4.156 seconds for React PDF and 4.213 seconds for Chromium. The 3,200-entry annual report took 18.789 seconds and 306.8 MiB in a single recovered Pi run. On the VPS, its annual report took a median 1.632 seconds and 234.2–244.9 MiB across three runs. Both comparisons independently verified report data and sampled layouts. [Issue #3 handoff](../hand-offs/issue-3-implementation.md)

Add the production dependency and integrate pdfmake in [issue #18](https://github.com/drblue/timekeeper/issues/18). Keep PDF jobs asynchronous in a worker process with initial concurrency one. Verify the integrated job path and choose production resource limits using target measurements. The report layout and content requirements are defined in the [product specification](../specification.md#9-pdf-reports).
