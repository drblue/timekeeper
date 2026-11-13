# Issue 9 implementation handoff

- [GitHub issue #9](https://github.com/drblue/timekeeper/issues/9), ENTRY-03–04, A06. Base `deac4d0`.
- Reused GPT-6.1 Sol/high for backend, GPT-6.1 Sol/medium for browser implementation, GPT-6.1 Terra/medium for independent validation, and GPT-6 Astra/high for independent review.

## Behavior

- Switch requires explicit confirmation tied to the current timer ID and revision. The stop and replacement start share one captured instant and one transaction, including the idempotency receipt. Cancel leaves the timer running. Failure while writing the replacement rolls back the old stop.
- Continue opens a current preview for a prior entry. It copies description, association, billability, and saved rate, including zero or missing rates. When rates differ, it offers the current default and initially selects the saved rate. A stale source revision, changed default, or unavailable association rejects the transition before changing the active timer.
- Both actions use the same browser request and retry path as start and stop. The browser fetches current timer state after a response or replay. Closing a confirmation restores focus, including when the original trigger is unavailable.
- No schema or dependency changes. Invoice status and metadata are scheduled for later work. The timer copies only the documented work fields and uses a new ID.

## Verification

- Implementation `079eff8`. Terra passed type checking, production build, 48 server tests, and 22 pinned Chromium tests. Independent API and browser checks covered shared switch instants, rejection without writes, replay after a deliberately lost response, 800/900 rate choice, archived and changed targets, and zero versus missing rates.
- Desktop and phone emulator checks covered decline, confirmation, and offline focus restoration. Impeccable's detector reported no findings on changed controls and styles. The build reported a 505 kB minified chunk warning.
- Astra's reviewed 14-file manifest `8f5921fff36f200440591c79bec30d8c2d53616c0000242e49cb17a6b8c64790` matched the staged files. The focus finding was resolved. No open code review findings remain.
