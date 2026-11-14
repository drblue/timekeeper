# Issue 26 implementation handoff

- [GitHub issue #26](https://github.com/drblue/timekeeper/issues/26), OPS-01. Base `7b6ce41`.
- Reused GPT-6.1 Sol/high for runtime implementation, GPT-6.1 Sol/medium for operator documentation, GPT-6.1 Terra/medium for independent validation, and GPT-6 Astra/high for independent review.

## Behavior

- The Compose package has native runtime and migration image targets. The application uses a private persistent bind, a nonroot user, a read-only filesystem, and a host-loopback port for an HTTPS reverse proxy. The migration service runs separately without network access.
- Liveness checks the API process. Readiness checks the database and migration history. Startup refuses an incompatible schema. The deployment guide covers fresh installation, migration, a verified pre-upgrade backup, and rollback.
- Actual production hostname, access routing, certificate policy, and encrypted backup destination remain operator choices.

## Verification

- Implementation `a649d8d`. Terra independently passed type checking, the production build, 112 server tests and 78 Chromium tests. A local native ARM64 Compose run verified startup gating, native drivers, private storage, replacement and upgrade from a populated database.
- Native ARM64 Pi 4 and x86-64 VPS Compose runs passed source checks, first migration, protected HTTPS, restart and replacement, exact work persistence, PDF and archive generation, and the populated 0015→0016 upgrade. Disposable resources were removed. [Native Compose verification](../native-compose-verification.md)
- Astra's exact 13-file manifest `7a8f0e8da29c3fda8a9dd8859a3bcc286f5aa78445deb2549d6a94a3275dd43d` matched the staged implementation. No open source findings. The Pi lacks Docker memory enforcement and throttled during its build.
