# Issue 17 implementation handoff

- [GitHub issue #17](https://github.com/drblue/timekeeper/issues/17), PDF-01–02. Base `3c2c1d7`.
- Reused GPT-6.1 Sol/high for backend, GPT-6.1 Sol/medium for browser implementation, GPT-6.1 Terra/medium for independent validation, and GPT-6 Astra/high for independent review.

## Behavior

- Report branding stores a business or owner name and optional account-owned PNG. The private asset path uses a generated UUID. Bounded normalized PNG bytes live in SQLite with the branding record so replacement, snapshots, and backup data remain consistent.
- Uploads are limited to 1 MiB and 1600 × 1600 pixels. A preflight checks chunk structure, dimensions, and inflated size before pinned `pngjs` 7.0.0 validates and canonicalizes the image. The accepted format is non-interlaced 8-bit PNG. Logo writes compare the expected current logo ID under the writer lock.
- The report keeps English or Swedish labels independent of the English app interface. Time-only remains the default. Rates and amounts and the detailed appendix are independent options. Presentation changes preserve totals and list scope.
- Live preview and settings can refresh a failed logo without losing filters or options. A later PDF job can use the immutable report input's captured logo bytes even if branding changes. Migration 0012 adds account report settings.

## Verification

- Implementation `20f1c3a`. Terra passed type checking, production build, 72 server tests, and 54 pinned Chromium tests. Independent migration and API checks covered ownership, malformed and oversized PNGs, replacement/removal, stale-write protection, restart persistence, immutable report options, and unchanged totals.
- Desktop and phone Chromium verified branding, Swedish labels with English app controls, appendix and monetary options, and recovery after a failed logo request. Impeccable returned no findings on changed UI.
- Astra's final 26-file manifest `e4676c1373965a45e445c25b45c41f6dc0dad3a02c73bb39853d660385f2985b` matched the staged files. Independent PNG corruption and inflate-boundary checks passed. No open findings.
