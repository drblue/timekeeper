# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Timekeeper is designed first for Johan Nordström’s own client work. He records time as he works or fills it in later, checks what is ready to invoice, and shares time reports with clients. Each installation serves one account, provisioned by the operator.

## Product Purpose

Record work, understand time spent and billable amounts by client and project, and keep track of which entries were included on invoices created in external bookkeeping software. A client-ready PDF should explain the work and reconcile with the completed time shown for the same scope in Timekeeper.

## Positioning

Timekeeper brings time recording, billable amounts, and client reporting together in a self-hosted workspace. Each entry retains its assigned hourly rate as defaults change. An optional invoice number links work to bookkeeping, and the Clockify import is designed to carry historical work forward without duplicating it on repeat imports.

## Operating Context

- Use the online browser app on desktop and phone. Browser installation is in scope where supported. Native apps and offline synchronization are deferred.
- Use English interface text with Swedish date and currency formatting, SEK, 24-hour time, and Monday-first weeks. Reports use Europe/Stockholm calendar boundaries and can use English or Swedish labels independently of the interface.
- Open the current week by default. Keep the timer accessible and preserve filters, sorting, and list position when reviewing or correcting entries. Start a report with the current filters and allow them to be adjusted before export.
- The deployment targets are a self-hosted ARM64 Raspberry Pi 4 and an x86-64 VPS. The separate encrypted backup destination and production domain and remote-access setup are open decisions.

## Capabilities and Constraints

The [product specification](docs/specification.md) defines the agreed first-release scope. The [README](README.md) and application code describe the current implementation.

- Keep one running timer across devices and preserve it across browser closure and server restart. A stopped timer with missing information becomes an incomplete entry. Manual entry supports both known start/end times and a date with duration only.
- A time entry can belong to a project, directly to a client, or neither. Project entries derive their client from the project. Show billability and the assigned rate so the owner can verify the amount. Keep archived clients and projects available for historical reporting.
- Track invoice status and optional invoice metadata. Preserve prefixes and leading zeros in invoice numbers. Require explicit unmarking before editing invoiced work details. Keep non-billable work distinct from billable work awaiting invoicing.
- Use the same completed-work scope and daily allocation for list and report totals. Client-ready A4 PDFs default to time only and can include rates and amounts. Reports summarize descriptions, show hours by day, and show each project’s share of time.
- Preview and confirm Clockify imports, resolve conflicts explicitly, and preserve source identity across edits and ordinary deletion. Support full data export, entry CSV export, and recoverable backups.

## Brand Commitments

The product name is Timekeeper. Use the domain language in the [glossary](GLOSSARY.md), including **time entry**, **billable amount**, and **time report**.

## Evidence on Hand

- [Discovery notes](docs/discovery.md) preserve the confirmed workflow decisions and describe the supplied Clockify CSV. Use synthetic or sanitized examples in shared artifacts.
- The [manual entry wireframe](prototype/new-time-entry/README.md) illustrates timed and duration-only entry on desktop and phone.
- The [PDF renderer evaluation](docs/report-renderer-evaluation.md) records report fixtures and layout checks.

## Product Principles

1. Give live tracking and retrospective entry equal weight. Preserve the facts the owner has, including work recorded with only a date and duration.
2. Preserve the value and history of recorded work. Keep assigned rates stable when defaults change and make billing corrections explicit.
3. Keep totals consistent from the entry list to the PDF. Use actual elapsed time, Stockholm calendar boundaries, and consistent rounding and allocation.
4. Make consequential changes reviewable and recoverable. Confirm server-side saves, expose conflicts, and retain enough history to understand edits, imports, and invoice status changes.
