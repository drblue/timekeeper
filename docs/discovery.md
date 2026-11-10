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
- Store the effective hourly rate on each entry when created. Changes to defaults affect future entries, preserving existing entry rates. Explicit entry overrides are supported. Backdated rate selection was resolved in round 2.
- Use the term billable amount for duration multiplied by hourly rate. Start with SEK as the single currency; VAT and invoice generation are outside initial scope.
- Invoices are created elsewhere. Support individual and bulk invoice marking, reversal of accidental marking, and optional invoice references.
- Permit one running timer. It continues to count across browser closure and server restart. Starting another activity offers to stop the current timer and start the next. Forgotten timers can be corrected; there are no automatic idle deductions.
- Distinguish non-billable work from uninvoiced billable work.
- Deliver an online, responsive browser application for desktop and phone. Defer offline synchronization and native applications. Installability is still open.

## Confirmed interview decisions — round 2

- Manual entries accept either start/end times or a date and duration. Duration-only entries have no invented timestamps. Completed entries require a description; timers may start without one.
- Continuing previous work creates a separate entry with the same description, project/client, and billing settings. Reports may summarize separate sessions together.
- Known timestamp overlaps produce a warning but are allowed. Duration-only entries cannot be checked for exact overlap.
- Reporting uses Europe/Stockholm time and inclusive date ranges. Timed work crossing midnight is allocated to each calendar day; duration-only work belongs entirely to its selected date.
- Preserve timer seconds and accept hours/minutes for manual duration. Do not round time to billing increments. Calculate amounts from stored duration, round each entry amount to öre, and sum entry amounts for totals.
- Backdated entries use defaults applicable at creation, with an editable rate; historical rate schedules are outside initial scope. Direct-client entries inherit the client's rate. Billable entries without a default require an explicit rate, including an explicit zero if desired. Non-billable work has zero billable amount.
- PDFs default to time-only reporting, with an option to include hourly rates and billable amounts. Reports support invoice-status and billability filters and exclude running timers.
- Summaries group by client/project and description, trimming surrounding whitespace but preserving case distinctions. When rates are shown, different rates form separate groups.
- Pie charts represent hours; entries without a project use a No project category. Both charts use the report's filtered entries. Bar charts include zero-hour days. Reports with no recorded time show an empty state instead of a 100% pie.
- Invoiced entries cannot be edited until explicitly marked not invoiced. The not-yet-invoiced filter excludes non-billable entries; all entries and billability filters keep those accessible.
- Archive clients/projects with entries instead of deleting them. Archived records remain available in historical filters/reports but are hidden from normal new-work choices. Projects with entries cannot move to another client.

## Remaining discovery areas

- Editing, reassignment, rate refresh, and deleting entries.
- Partial date-range reporting and invoice marking across midnight.
- Timer interruptions, simultaneous devices, and incomplete work.
- Login, backup, recovery, and deployment.
- Report presentation, language, and default views.
