# Requirements discovery

This document records confirmed requirements during the interview. It is not the final specification; unresolved behavior must not be treated as approved.

## Initial requirements

- Record work using a timer or manually after the fact.
- Filter entries by any combination of date range, project, and client.
- Filter entries by invoiced, not invoiced, or all statuses.
- Export PDF time reports for a date range and optional client and/or project.
- Reports include daily hours in a bar chart and project shares in a pie chart, with the legend to its right. A single-project report shows a full pie labeled 100%.
- Reports summarize entries by description and time spent.
- Clients have default hourly rates. Projects inherit their client's rate unless overridden. Entries inherit their project's rate unless overridden.
- Show each entry's billable amount.
- Initially host on a Raspberry Pi 4, with a later move to a Hetzner VPS. Docker is preferred.
- Desktop and iOS applications are possible later additions.

## Confirmed interview decisions — round 1

- Start with one user and login protection, with records associated with the user's account. Team and shared-client features are outside initial scope.
- Each project belongs to at most one client. Entries may belong to a project, directly to a client, or neither. A project entry derives its client from the project.
- Store the effective hourly rate on each entry when created. Changes to defaults affect future entries, preserving existing entry rates. Explicit entry overrides are supported. Rate selection for backdated entries is unresolved.
- Use the term billable amount for duration multiplied by hourly rate. Start with SEK as the single currency; VAT and invoice generation are outside initial scope.
- Invoices are created elsewhere. Support individual and bulk invoice marking, reversal of accidental marking, and optional invoice references.
- Permit one running timer. It continues to count across browser closure and server restart. Starting another activity offers to stop the current timer and start the next. Forgotten timers can be corrected; there are no automatic idle deductions.
- Distinguish non-billable work from uninvoiced billable work.
- Deliver an online, responsive browser application for desktop and phone. Defer offline synchronization and native applications. Installability is still open.

## Remaining discovery areas

- Manual-entry input, timer continuation, overlaps, and duration precision.
- Time zone, date boundaries, and cross-midnight work.
- Rate fallback, backdated rates, rounding, and reassignment.
- Report grouping, chart allocation, empty data, and financial visibility.
- Invoice-state safeguards and non-billable filtering.
- Client/project lifecycle and historical data preservation.
- Login, backup, recovery, deployment, and interface preferences.
