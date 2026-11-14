# Issue 16 implementation handoff

- [GitHub issue #16](https://github.com/drblue/timekeeper/issues/16), PDF-01, PDF-03–04, A10, A14. Base `5643118`.
- Reused GPT-6.1 Sol/high for backend, GPT-6.1 Sol/medium for browser implementation, GPT-6.1 Terra/medium for independent validation, and GPT-6 Astra/high for independent review.

## Behavior

- Report preview starts with the work list's effective dates and filters and allows adjustments. Its Back link restores the list scope. Reports use the same persisted allocations, including partial dates, and exclude incomplete, running, deleted, and superseded work.
- The renderer-independent report builder reads a consistent snapshot, then prepares immutable totals, daily series, project shares, and description summaries. The preview enumerates zero-hour days and limits the inclusive range to 3,660 days.
- Project shares use duration and distinguish project IDs, with No project for unassigned work. Summaries trim descriptions, preserve case, and keep client and project identities separate. Time-only is the default. Showing money separates rows by saved rate. Identical display names receive distinguishing labels only when they collide.
- The desktop preview places the project legend beside the chart and the phone layout stacks it. A sole project displays 100%. Exact daily values remain accessible in a table. Presentation settings and PDF jobs are later tickets.

## Verification

- Implementation `36ad251`. Terra passed type checking, production build, 70 server tests, and 52 pinned Chromium tests. Independent API checks verified exact list parity, excluded states, archived projects, description/rate grouping, tiny shares, zero days, and read-only behavior.
- Desktop and phone Chromium walkthroughs checked transferred scope, filter changes, 100% and small shares, the money toggle, same-name labels, and return navigation. Impeccable returned no findings on changed UI.
- Astra's final 20-file review manifest `da6da46a7daf6a1a881966b1d27c7b0882b76c4b9343d51556e968f2faa36610` matched the staged files. No open findings. PDF output remains in issue #18.
