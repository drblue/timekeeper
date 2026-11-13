# Issue 8 implementation handoff

- [GitHub issue #8](https://github.com/drblue/timekeeper/issues/8), ENTRY-01, ENTRY-04, A01–03. Base `caf1950`.
- Reused GPT-6.1 Sol/high for backend, GPT-6.1 Sol/medium for browser implementation, GPT-6.1 Terra/medium for independent validation, and GPT-6 Astra/high for independent review.

## Behavior

- The workspace timer keeps one server-side start per account. It survives browser and server restarts, refreshes across devices, and flags elapsed time after 12 hours. The browser estimates elapsed time locally from the last confirmed server state during a disconnect.
- Start and stop use account-scoped idempotency receipts. Stop creates the entry and its history, removes the running timer, and records its receipt atomically. The browser fetches current state after each operation. An uncertain request can be retried with its original key after a same-tab reload. Explicit sign-out clears the browser retry draft.
- Stops with missing completion information preserve actual elapsed time, including a same-second stop. Incomplete entries have no billable amount or allocations. A focused completion form saves the missing details with a revision check. Timer and manual entry creation share the billing and persistence paths.
- Migration 0005 adds the timer, receipt, and history tables and preserves existing entries and allocations. The project’s client stays fixed while the timer is running or recorded work refers to it.

## Verification

- Implementation `9fa1301`. Terra passed `npm run check`: type checking, 44 server tests, production build, and 18 pinned Chromium tests. Independent disposable checks exercised populated migration, server restart, concurrent starts, two tabs, a lost committed stop response, exact receipt replay, the 12-hour warning, and completion. Desktop and phone Chromium layouts were visually checked.
- Astra reviewed the final 28-file manifest `3eb0e4c31a7a7191dfc9526c53ecbee73e89a688acc3be777e2d5c325268b247`. Hidden-rate and invalid-duration focus findings were fixed and rechecked. The staged files matched the review fingerprint.
- Impeccable's detector reported no findings on the changed timer, form, and styles. Browser phone verification used emulation.
