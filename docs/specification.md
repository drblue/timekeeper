# Timekeeper — Product Specification

Version: 1.2
Date: 2026-11-10
Status: Initial specification based on the user-confirmed discovery scope.

## 1. Purpose and authority

Timekeeper lets one person record work, understand time spent by client and project, track billable amounts and external invoicing, and produce client-ready PDF time reports. It must support live tracking and retrospective entry equally well.

This document consolidates the approved scope in [discovery.md](discovery.md). It is the implementation-facing product specification; discovery retains the interview history. [GLOSSARY.md](../GLOSSARY.md) defines canonical terms. Requirements below are required for the first release unless explicitly deferred. Acceptance scenarios illustrate required behavior and are not an exhaustive test suite.

The selected stack is React/Vite, TanStack Router/Query, Node.js/Fastify, Prisma 7 with SQLite initially, and pdfmake for server-side PDF rendering. PostgreSQL and MariaDB remain architectural migration targets. Implementing their transfer tooling is optional, very-low-priority future work. Use TypeScript, ESModules, and tabs. Production dependency additions follow the project's working agreements. [Technical design](technical-design.md), [PDF renderer decision](adr/0002-pdfmake-for-time-reports.md)

## 2. Product boundaries

### Included

- One login-protected account with owned records.
- Responsive, online browser application, installable where browsers support it.
- Clients, projects, timer-based and manual entries, rates, billability, invoice tracking, history, and trash.
- Filtered reporting, PDF generation, complete data export, and entry CSV export.
- Clockify CSV import with preview, repeat-import protection, conflict resolution, and guarded undo.
- Docker Compose hosting on ARM64 Raspberry Pi 4 and x86-64 Hetzner VPS; backup, restoration, and migration procedures.
- Initial SQLite persistence designed for later PostgreSQL or MariaDB migration, preserving historical and import-identity data. Full transfer tooling/rehearsals are optional future work.

### Excluded

- Teams, shared workspaces, public registration, and multiple currencies.
- Offline synchronization and native desktop or iOS applications.
- Invoice generation, VAT calculation, payment tracking, expenses, and budgets.
- Recurring entries, full task/tag management, and external integrations other than Clockify import.
- Historical rate schedules and client contact/address/tax/payment-term management.

## 3. Domain model and invariants

These are logical concepts, not a mandated database schema.

| Concept | Required information and relationships |
| --- | --- |
| Account | Login email, credentials, ownership of records; one account initially. |
| Client | Name, default hourly rate, optional notes, archive state. |
| Project | Name, optional single client, inherited or overridden rate, default billability, optional notes, archive state. |
| Time entry | Description; timed or duration-only representation; project, direct client, or neither; billability; assigned rate; completion and invoice states; ownership and change history. |
| Running timer | Account's single active work measurement, persisted start instant and work settings. |
| Invoice metadata | Optional invoice number, date, and reference/note; marking timestamp separately. |
| Entry history | Change kind, timestamp, and previous values sufficient to inspect changes. |
| Import batch | Preview decisions, execution outcome, counts, source records, mappings, and undo eligibility. |
| Import source identity | Original source identity and matching decisions independent of editable entry values. |
| Report settings | Owner/business name, optional logo; report-specific language, filters, money visibility, and appendix selection. |

Invariants:

1. An entry with a project derives its client from that project; it cannot independently select a conflicting client.
2. A project has at most one client. Once it has entries, its client association cannot change.
3. At most one timer runs per account across all devices.
4. Duration-only entries do not have fabricated start/end timestamps.
5. Existing assigned rates never change merely because defaults change.
6. Incomplete and running work cannot contribute to report totals or be newly marked invoiced.
7. Invoiced work details cannot be edited or deleted until explicitly unmarked. Invoice metadata corrections are allowed separately.
8. Non-billable work has zero billable amount and is not eligible for invoice marking.
9. Reimport identity survives local edits and ordinary entry deletion.

Completion, invoice status, and deletion are separate dimensions. An imported record may retain source invoice status while incomplete; it remains excluded from reports until completed. Supplying missing completion information on such a record must respect the unmark-before-edit rule.

## 4. Access and interface

### ACCESS-01 — Account access

Provide an administrator-created email/password account, login, logout, password changes, login attempt limiting, and a documented server-side reset procedure. Do not require an email service or offer public signup. Protect application records, reports, exports, imports, and settings behind authentication.

### UI-01 — Browser experience

Support desktop and phone layouts and browser installation as a standalone window or home-screen app where supported. Installation does not imply offline operation. Use English interface text, Swedish date/currency formatting, SEK, 24-hour times, and Monday-first weeks.

### UI-02 — List defaults and navigation

Fresh sessions open the current week, all invoice statuses, with entries newest first grouped by day and a prominent running-timer control. Provide Today, This week, This month, Previous month, and Custom range shortcuts. Preserve filters, sorting, and list position when opening, editing, and returning from entries.

## 5. Recording and editing work

### ENTRY-01 — Live timer

A timer can start before a description or rate is supplied. Persist its start and state so browser closure and server restart do not stop elapsed time. Starting different work offers an explicit stop-current/start-next action. Flag a timer after 12 hours without stopping it or deducting idle time.

Stopping preserves the recorded time even when completion information is absent. Save such work as incomplete and prompt for missing information. Completed entries require a nonblank description, positive duration, and an explicit or inherited rate if billable; explicit zero is valid.

### ENTRY-02 — Manual work

Offer Duration only and Timed modes in the same form. Duration only takes a work date and an editable hours:minutes:seconds field. Timed work takes start and end dates and times and uses the same duration format.

Accept compact digits and colon-separated values. Clock inputs `0900`, `1030`, and `145` display as `09:00`, `10:30`, and `01:45` when the field loses focus. Duration inputs `3000`, `11500`, and `80000` display as `00:30:00`, `1:15:00`, and `08:00:00`. A duration with zero hours or an exact number of hours displays at least two hour digits. Other durations show the hour count without leading zeros. Existing start, end, and duration values appear as compact digits when focused.

Editing Duration recalculates End from Start. Editing End recalculates Duration. A subsequent Start edit preserves whichever of End or Duration was last edited. Show the end date when the calculation crosses midnight. Reject an end before its start and reject zero-duration completion. Warn about overlapping known intervals, but permit them. Duration-only work cannot be checked for exact overlap.

### ENTRY-03 — Continuing and correcting

Continuing an entry creates a separate work session with copied description, client/project, billability, and rate. Invoice metadata/status are not carried forward as already invoiced. If the copied rate differs from today's applicable default, show a notice and an action to use that default.

Allow uninvoiced work to change description, timing, association, rate, and billability. Description/duration edits do not refresh the rate. Reassigning a client/project asks whether to keep the rate or apply the new default, selecting retention initially.

Allow conversion between timed and duration-only forms, preserving description, billing settings, and history. Converting to timed requires explicit timestamps. Preview resulting changes in duration and amount.

### ENTRY-04 — Connection and concurrency

Start/stop actions require server confirmation. A disconnected display may continue counting, but must not imply that an unconfirmed stop was saved. Multiple devices must converge on the same timer. Reject stale conflicting edits with a refresh/review path rather than silently overwriting newer work. Retrying a confirmed operation must not create duplicate sessions.

### ENTRY-05 — History and deletion

Expose history in entry details: edits, rate changes, invoice marking/unmarking, splits, deletion, and restoration, including timestamps and previous values. Bulk deletion requires confirmation. Keep deleted entries restorable for 30 days; exclude trash from ordinary lists and reports. Deleting invoiced work first requires explicit unmarking.

## 6. Clients, projects, and billing

### BILL-01 — Default resolution

| Entry association | Default rate | Default billability |
| --- | --- | --- |
| Project | Project override, otherwise associated client's rate | Project setting |
| Direct client | Client rate | Billable |
| Neither | No rate default | Non-billable |

New projects default to billable. Entries can override billability and rate. A project without a client needs its own rate or an explicit entry rate for billable completion. Missing rates are not equivalent to zero.

Resolve and store the entry's assigned rate when created from available defaults. Ordinary backdated entries use creation-time defaults, with editing available. Missing information may be completed later. Clockify historical-rate rules take precedence for imported work.

### BILL-02 — Amount calculation

Calculate billable amount as recorded seconds divided by 3,600, multiplied by the assigned hourly rate. Do not round duration up to billing increments. Round each full entry amount to öre and sum entry amounts for totals. Use exact monetary calculations rather than accumulating binary floating-point errors.

Allocate an entry's rounded amount consistently across daily portions so their sum equals its full amount. The [technical design](technical-design.md) defines the deterministic rounding/allocation algorithm reused by list totals, reports, and splitting. A midnight split must preserve total seconds and total rounded amount.

### CLIENT-01 — Lifecycle

Warn about duplicate client names and project names within the same client. Archive clients/projects with work rather than deleting those records. Archived items remain available to historical filters and reports but are hidden from normal choices for new work. Renaming updates the current interface and newly generated reports, without changing associations or rates. Existing downloaded PDFs do not change.

## 7. Dates, filtering, and totals

### TIME-01 — Calendar semantics

Use Europe/Stockholm for reporting. A selected date range includes both dates: interpret it as local midnight on the first date through, but excluding, local midnight following the last date. Use calendar boundaries rather than assuming every day lasts 24 hours.

Timed work is allocated to each intersected calendar day; duration-only work belongs entirely to its date. Report only the portion inside the selected range. Timed duration measures actual elapsed time across daylight-saving changes. Ambiguous manual local times require occurrence selection; nonexistent local times are rejected.

### LIST-01 — Filters and search

Combine date range, client, project, invoice status, and billability using AND. Clearly show incompatible client/project selections rather than silently broadening the results. Support description search and invoice-number search. Invoice choices are all, invoiced, and not yet invoiced; the last means billable work not marked invoiced, excluding non-billable work.

Show completed hours and billable amounts for active filters using the same allocation rules as reports. Show running and incomplete work separately from those totals. Bulk actions apply only to explicitly selected records, with an explicit action for selecting all matches across pages.

## 8. External invoice tracking

### INV-01 — Marking and metadata

Allow individual and bulk invoice marking/reversal. Before marking, show selected count, hours, and amount. Accept shared optional invoice number, invoice date, and additional reference/note. Treat the number as text, preserving prefixes and leading zeros. Multiple entries may share it. Store marking time independently of the invoice date.

Invoice number is the primary searchable link to external bookkeeping. Allow metadata corrections without unlocking work details. Report export never changes invoice status.

### INV-02 — Date-boundary protection

When bulk marking from a date-filtered list, flag entries containing time outside that range. Do not silently mark outside-range work. Offer to split at relevant midnights and mark only the included portions, preserving the original total duration and amount and recording the split history.

## 9. PDF reports

### PDF-01 — Scope and content

Report creation starts from current list filters, editable before generation. Include completed, nondeleted entries only. Support invoice-status and billability filtering as well as date/client/project selection. Report rows, summary totals, and both charts must derive from the same filtered allocation.

Default to time-only output; optionally include hourly rates and billable amounts. Select English or Swedish labels independently of interface language. PDFs are time reports, not invoices.

### PDF-02 — Layout

Use A4 portrait with a title, configurable owner/business name, optional logo, selected scope, inclusive date range, and total hours. Include page numbers, repeated table headers, and an optional detailed-entry appendix. Prevent clipped text and charts. Regeneration reflects current names and permitted corrections.

### PDF-03 — Charts

- Bar chart: daily hours, including days with zero hours. Split long date ranges into readable monthly panels without replacing daily bars with monthly totals.
- Pie chart: overall project shares by duration, never monetary amount. Use No project for entries without a project.
- A sole project with recorded time produces a full pie labeled 100%. No recorded time produces an empty state, not a 100% pie.
- Show percentage labels and a right-hand legend listing project name, hours, and percentage. Retain every project rather than merging into Other.
- Use numbered/color-coded references and explicitly labeled legend continuation pages when necessary. Keep the chart-page legend on the right. Use sufficient precision to avoid rendering nonzero shares as 0%.

### PDF-04 — Description summaries

Group within client/project by description after trimming surrounding whitespace. Preserve case distinctions. Sum allocated duration and, when enabled, amount. If rates are displayed, separate different rates. Identical descriptions under different projects/clients stay separate. Project identifiers, not display names alone, distinguish groups.

## 10. Clockify CSV import

### IMPORT-01 — Supported baseline

Support the supplied Clockify export structure with these headers:

`Project`, `Client`, `Description`, `Task`, `User`, `Group`, `Email`, `Tags`, `Start Date`, `Start Time`, `End Date`, `End Time`, `Duration (h)`, `Duration (decimal)`, `Date of creation`.

The sample is UTF-8 comma-delimited CSV with DD/MM/YYYY dates, HH:mm:ss times/durations, and rounded decimal hours. It contains 29 entries; 12 carry the invoiced tag. There are no stable source IDs, rates, currency, billable flag, or timezone. This is a supported baseline, not a promise to accept every Clockify export variant. Unsupported layouts must produce a clear error without writes.

### IMPORT-02 — Preview and mapping

Parse as data, never executable content. Before mutation, show new records, already imported records, conflicts, invalid/incomplete records, and clients/projects proposed for creation. Require explicit confirmation of the final selection.

- Default timezone to Europe/Stockholm, visibly adjustable. Use exact Duration (h), not rounded decimal hours. Flag timestamp/duration discrepancies and daylight-saving ambiguity for resolution.
- Suggest clients by name and projects by name within client. Confirm matches, resolve ambiguity, and approve creation. Do not alter defaults from imported rates.
- Visibly map the invoiced tag to invoiced status; blank tags mean not yet invoiced. Missing invoice number/date are allowed.
- Require historical rates or explicit non-billable classification, including for invoiced records. Offer bulk client/project assignment and per-row overrides; do not silently apply current defaults or zero.
- Permit explicitly accepted missing descriptions/rates as incomplete records. Malformed unresolved data blocks its row. By default unresolved invalid rows block execution; allow explicit exclusion and import of the valid remainder.
- Preserve tags, task, user/email, group, and creation date as source information, without full tag/task features. Require explicit user selection for multi-user exports.

### IMPORT-03 — Identity and conflict handling

Retain original source identity separately from local editable fields and filenames. Exact repeats must be recognized across renamed files and overlapping export ranges, even after local edits or ordinary deletion.

Treat matching source user/start/end with differing other fields as a possible correction. Preview differences and offer keep existing, update existing, or import separately. Preserve local billing data absent from the CSV. Respect invoice-editing restrictions and remember resolutions so the same row does not repeatedly cause a conflict.

Flag identical rows inside one export: default to importing one, allow explicitly keeping both, and preserve multiplicity decisions across repeated imports. Do not equate source row number with identity; export ordering may change.

Retain identity tombstones after ordinary deletion to prevent resurrection, offering explicit restoration where possible. Substantially changed source records, particularly changed timestamps, may require manual matching because the format lacks stable IDs. Never promise automatic identification of all edited source records.

### IMPORT-04 — Execution and undo

Apply each approved import selection atomically, including its identity records and required record creation; failure must not leave a partial import. Keep batch history with counts, outcomes, and decisions.

Undo previews its effects. Newly created entries go to trash; client/project records remain. Existing entries updated by the batch may revert only if unchanged since. Do not undo entries subsequently edited or newly marked invoiced without resolving those changes. Explicit import undo permits reimport; ordinary entry deletion does not. Initially imported invoice status alone is not a subsequent marking action.

## 11. Export, operations, and data protection

### OPS-01 — Deployment

Provide Docker Compose deployment for ARM64 Raspberry Pi 4 and x86-64 VPS. Keep persistent data outside replaceable application containers. Configure storage and domain settings without code changes. Keep the database private and use HTTPS through a reverse proxy for remote access. Document installation, upgrades, and migration between supported hosts.

### OPS-02 — Backups and recovery

Create daily backups with 30-day retention. Support encrypted copies to a destination outside the application host. Include all data needed to preserve work, settings, history, invoice states, import identities, and undo information. Document restoration and verify an actual restore before production reliance. Selecting and configuring the external destination remains a deployment prerequisite, not a completed feature merely because local backup files exist.

### OPS-03 — Portable exports

Provide a complete data export and filtered entry CSV export. Complete export must preserve relationships and import identities, not merely visible entry fields. Keep secrets out of ordinary user-facing exports. Document the distinction between portable export and operational backup.

### OPS-04 — Database migration targets

When a future database migration is prioritized, support a planned transfer from SQLite to PostgreSQL or MariaDB with provider-specific schemas/migrations and preserved IDs, relationships, amounts, daily allocations, invoice metadata, history, import identities/tombstones, and undo information. Validate data and behavior against real target databases before cutover. Preserve a rollback source and document the boundary after which new target writes require reconciliation. Changing the database URL alone is not a supported migration procedure. Provider-neutral design and early compatibility checks remain in scope; full transfer implementation and A23–A24 are optional and do not gate the initial SQLite release.

## 12. Acceptance scenarios

| ID | Scenario and required result |
| --- | --- |
| A01 | Start a timer, close the browser, restart the server, and reopen on another device: one timer remains active with correct elapsed time. |
| A02 | Two devices attempt to start work simultaneously: at most one timer is created; no silent overwrite occurs. |
| A03 | Stop without a description/rate: time is saved as incomplete, excluded from totals/reports/invoice marking, and can be completed later. |
| A04 | Enter 90 minutes without timestamps: the date and duration are retained without manufactured clock times. |
| A05 | Change a client default from 800 to 900 SEK/hour: existing entries retain 800; a new inheriting entry uses 900. |
| A06 | Continue the old 800-rate work: a new uninvoiced session retains 800 and offers the current 900 default. |
| A07 | Track 23:30–00:30 on an ordinary night: each day receives 30 minutes. Selecting one day reports only its portion. |
| A08 | Cross a daylight-saving change: measured duration reflects elapsed time; ambiguous manual input requests an occurrence. |
| A09 | Split a boundary entry before invoicing: allocated seconds and öre sum to the original, and outside-range work remains uninvoiced. |
| A10 | Combine client, project, date, and invoice filters: every result satisfies all filters; list completed totals equal the corresponding report totals. |
| A11 | Try editing an invoiced entry: work changes are blocked until unmarked, but invoice-number correction is allowed and preserves leading zeros. |
| A12 | Archive and rename a project: history remains reportable under the current name, while normal new-work choices omit the archived project. |
| A13 | Generate single-project, empty, multi-project, and year-long reports: 100%, empty state, complete legend, and readable monthly daily-bar panels respectively. |
| A14 | Report matching descriptions across different projects and rates: projects remain separate, and differing rates separate when displayed. |
| A15 | Import all 29 sample rows with confirmed mapping/rates: 29 entries are created and 12 receive invoiced status. Reimport under a new filename: zero new entries. |
| A16 | Edit or ordinarily delete an imported entry, then reimport: no duplicate or resurrection occurs. |
| A17 | Import a corrected description with the same user/timestamps: show a conflict, preserve absent local billing information, and remember the chosen resolution. |
| A18 | Approve two identical source rows: both import once; repeating the export creates neither again. |
| A19 | Cause an import failure during application: no partial batch or identity state survives. |
| A20 | Undo an eligible import: created entries go to trash, unchanged updates revert, clients/projects remain, and explicit reimport is possible. |
| A21 | Open a stale edit after another device changes it: show conflict/refresh instead of overwriting newer data. |
| A22 | Restore a backup on a supported host: entries, rates, invoice metadata, history, settings, and repeat-import protection survive. |
| A23 | **Optional future migration:** Transfer a populated SQLite fixture to PostgreSQL: IDs, relationships, seconds, amounts, allocations, history, invoice states, and import behavior match. |
| A24 | **Optional future migration:** Repeat that transfer to MariaDB and verify the same invariants, including Unicode/case-sensitive grouping and transactional conflict behavior. |

Use synthetic or sanitized fixtures for automated tests; do not commit the user's raw Clockify export. Verify PDF layout visually with empty, dense, long-description, multi-page, and long-range reports. Verify the primary workflows on desktop and phone layouts. Validate both target deployment architectures before declaring hosting support complete.

## 13. Deferred choices and delivery gate

The following choices are intentionally left to technical design or deployment planning:

- Remaining exact dependency versions and schema/date-time helper choices described in the technical design.
- Separate encrypted backup destination and key management/recovery procedure.
- Production domain, reverse-proxy configuration, and remote-access arrangement.

Before implementation, technical design must resolve the listed implementation choices without weakening the confirmed behavior. Before production reliance, complete representative acceptance checks and a verified restoration exercise.
