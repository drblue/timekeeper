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

## Confirmed interview decisions — round 3

- Reports include only the portion of timed entries inside the selected date range and its corresponding amount. Allocate monetary rounding differences consistently so daily portions sum to the full entry amount.
- Bulk invoice marking flags entries crossing the selected date range and offers splitting at midnight before marking the included portion. Splitting preserves total duration and amount.
- Reassigning an uninvoiced entry to a project/client asks whether to retain its rate or use the new default, defaulting to retention. Description/duration edits do not change rates.
- Continuing old work copies billing settings exactly. A notice offers the current default when the copied rate differs from it.
- Deleted entries are recoverable from trash for 30 days. Invoiced entries must first be unmarked; bulk deletion requires confirmation.
- Stopping a timer without a description saves an incomplete entry, excluded from reports and invoice marking until completed. Unusually long timers are flagged without automatic stopping.
- Devices share the same running timer. Starting/stopping requires server confirmation; connection loss clearly indicates unsaved actions. Conflicting edits prompt refresh rather than silently overwriting work.
- Start with one administrator-created email/password account, no public registration or email service. Include logout, password changes, login attempt limits, a documented server-side password-reset procedure, and HTTPS for remote access.
- Include daily backups retained for 30 days, support for a separate backup destination, documented restore and Pi-to-VPS migration, and complete data export plus entry CSV export. Backup destination remains open.
- Initially use an English interface with Swedish date/currency formatting, 24-hour time, Monday-first weeks, and SEK. PDFs independently support English or Swedish labels.
- PDFs use A4 portrait with title, configurable owner/business name, optional logo, selected client/project, date range, total hours, charts, and description summaries. Include page numbers, repeated table headers, and an optional detailed-entry appendix.
- Main screen defaults to the current week and all invoice statuses. Show a prominent timer, filtered hours and billable totals, and entries newest first grouped by day. Date shortcuts: Today, This week, This month, Previous month, Custom range.
- Projects have an overridable billability default inherited by entries. New projects and direct-client work default to billable; work without a client/project defaults to non-billable. Make billability visible during entry.

## Confirmed interview decisions — round 4

- Missing description or billing information saves stopped work as incomplete. Completed entries require positive duration; end times before start times are rejected. Flag running timers after 12 hours without stopping them.
- Bulk invoice marking supports a shared optional invoice reference and invoice date, with marking time recorded separately. Reference/date corrections do not unlock work. Additionally support an explicit invoice number so invoices can be found in external bookkeeping software.
- Bulk actions affect explicitly selected entries. Offer explicit selection of all matches across pages. Show selected count, hours, and amount before invoice marking. PDF export never marks entries invoiced.
- Keep entry change history with prior values and timestamps for edits, rate changes, invoice marking/unmarking, splitting, deletion, and restoration, available in entry details.
- Clients need name, default hourly rate, and optional notes. Projects need name, optional client, rate settings, billability, and optional notes. Warn about duplicate client names and project names within a client. Addresses, tax numbers, contacts, and payment terms are outside initial scope.
- Renaming clients/projects updates app displays and newly generated reports while preserving associations and recorded rates. Downloaded PDFs remain unchanged; regeneration uses current data.
- Long reports split daily bar charts into monthly panels, retaining one overall project pie. Pie labels show percentages; its right-hand legend lists project names, hours, and percentages. Filters combine using AND and incompatible client/project selections are clearly shown.
- Separate backups should be encrypted and copied outside the application host. Verify restoration before relying on the app. The destination is explicitly deferred.
- Support ARM64 Raspberry Pi and x86-64 VPS deployment through Docker Compose, persistent data outside replaceable containers, configurable storage/domain settings, HTTPS through a reverse proxy, and a private database. Actual domain and remote-access setup are deferred until deployment.
- Include browser installation as a standalone window/home-screen app where supported, retaining online-only behavior. Native desktop/iOS applications remain future work.
- Include description search. Expenses, budgets, recurring entries, tags, and external integrations remain outside initial scope, except the explicitly requested Clockify import.
- Support importing Clockify CSV exports. Reimporting previously imported entries must not create duplicates. A user-provided 2025 export is the sample input; mapping and identity behavior are being investigated before specification.

## Confirmed interview decisions — round 5

- Invoice number is the main searchable external bookkeeping identifier; reference remains an optional note. Invoice numbers are text, preserving prefixes and leading zeros, and may be shared by entries.
- Imports require a preview and explicit confirmation, showing new entries, previously imported entries, conflicts, invalid rows, and clients/projects to create.
- Interpret the sample export in Europe/Stockholm time, with an adjustable timezone shown during import. Prefer exact Duration (h) over rounded decimal hours. Flag timestamp/duration disagreements and ambiguous daylight-saving times.
- Map the invoiced tag to invoiced status and blank tags to not yet invoiced, visibly in the preview. Imported invoiced entries need no invoice number/date; these may be added later.
- Require historical rate assignment or explicit non-billable classification for imports without rates, including invoiced records. Support bulk assignment by client/project and per-entry overrides. Do not silently apply present defaults or zero.
- Suggest client matches by name and project matches by name within client. Confirm matches, approve creation of missing records, and resolve ambiguous names explicitly. Imported historical rates do not change defaults automatically.
- Retain source identity separately from editable entries. Skip identical previously imported source rows across renamed files and overlapping exports, even after local edits. Same user/start/end with different other fields is a possible correction requiring review. Changed timestamps cannot always be matched without stable source IDs.
- Retain import identities after deletion so repeat imports do not resurrect entries. Offer explicit restoration where possible. Conflicts never silently overwrite existing records; invoiced corrections require unmarking first.
- Preserve Clockify tags, task, user/email, and creation date as source information without introducing full tag/task management. Invoiced tags additionally map to invoice status. Multi-user exports require explicit user selection.
- Invalid unresolved rows block import by default; explicitly excluding them permits valid rows to proceed. Apply each approved selection atomically. Keep import history with counts/outcomes. Allow undo of a batch when its entries have not subsequently been edited or newly marked invoiced.

## Sample export observations

The supplied Clockify CSV contains 29 entries and no stable entry IDs, rates, currency, billable flag, or timezone. Twelve entries carry the invoiced tag. It uses comma-delimited UTF-8, DD/MM/YYYY dates, HH:mm:ss times/durations, and rounded decimal hours. All sample durations agree with their timestamp intervals. These observations describe the sample, not every possible Clockify export.

## Confirmed interview decisions — round 6

- Timed entries measure actual elapsed time across daylight-saving changes. Manual ambiguous timestamps require explicit occurrence selection; nonexistent local times are rejected. Duration-only entries are unaffected.
- Uninvoiced entries may convert between timed and duration-only forms while preserving description, billing settings, and history. Conversion to timed requires explicit timestamps. Preview duration/amount changes before saving.
- Identical rows within an export are flagged and default to one import, with an explicit option to keep both. Retain this choice so repeat imports do not duplicate either entry.
- Import conflict resolution offers keep existing, update existing, or import separately, with a difference preview. Updates preserve local billing information absent from CSV and respect invoice-editing restrictions. Remember resolutions for repeat imports.
- Undoing an import moves newly created entries to trash and retains client/project records. Existing entries updated by that batch may revert only when unchanged since. Explicit import undo permits reimport; ordinary deletion continues to prevent accidental reimport.
- Missing import descriptions or rates may be supplied in preview or explicitly accepted as incomplete work. This refines the earlier validation rule: malformed data blocks rows, while explicitly accepted missing completion fields can be retained safely.
- Reports retain every project rather than merging small shares into Other. Use numbered/color-coded legends with explicitly labeled continuation pages as needed; the chart-page legend stays right of the pie. Use sufficient precision to avoid labeling nonzero shares 0%.
- List totals include completed entries only, consistent with reports. Running and incomplete work have separate indicators.
- Preserve filters, sorting, and list position during navigation/editing. Fresh sessions start on the current week. Report creation inherits current list filters, adjustable before export.

## Discovery status

All six interview rounds have been answered. The user confirmed the consolidated scope and requested the specification. The implementation-facing requirements are now in [specification.md](specification.md). No application implementation has started. The user subsequently selected React/Vite, TanStack Router/Query, Node.js/Fastify, and Prisma 7 with SQLite initially, with PostgreSQL and MariaDB as migration targets. React PDF remains provisional pending layout/resource validation. See [technical-design.md](technical-design.md) and [ADR 0001](adr/0001-prisma-and-portable-persistence.md).

## Explicitly deferred deployment choices

- Separate backup destination.
- Domain and remote-access setup.

## Technical design follow-up — 2026-11-10

The user approved Prisma instead of the initially proposed Drizzle because cross-database migration is required. SQLite remains the initial database; PostgreSQL and MariaDB are explicit transfer targets rather than initial production services. The technical design records provider-specific migrations and data-transfer verification, independent HTTP API/domain boundaries for future clients, and an early report-renderer evaluation. No dependencies or application code were added during this design task.
