# Issue 5 implementation handoff

- [GitHub issue #5](https://github.com/drblue/timekeeper/issues/5), CLIENT-01, BILL-01, A12.
- Base `10996c1` on `dev`. Implementation revision `22e74ff`. Issue #4 was closed before implementation began.
- Separate backend and browser agents used GPT-6.1 Sol at high reasoning. Independent validation used GPT-6.1 Terra at high reasoning. Independent code review used GPT-6 Astra at high reasoning.

## Behavior

- Clients and Projects pages support creation, editing, renaming, archive, and restore. The management view keeps archived records and their IDs. The active API view excludes archived records and projects whose clients are archived. Existing project associations can retain an archived client. A new association requires an active client owned by the account.
- Hourly rates use nonnegative integer öre represented as decimal strings at the API boundary. The browser accepts decimal commas and points. A blank project override inherits the client default. An explicit zero overrides it. New projects default to billable.
- Duplicate detection compares trimmed, lowercased NFC names across active and archived records. Client names are scoped to the account. Project names are scoped to the account and client, including an unassigned group. A duplicate response leaves the record untouched until the user confirms. Each record retains its own ID.
- Migration 0002 adds account-scoped client and project tables. The project foreign key constrains the related client to the same account. The API uses revision checks for edits and lifecycle changes and exposes no hard-delete action.

## Verification

- Terra passed `npm run check`, including type checking, the production build, 25 server tests, and eight Chromium tests across desktop and phone viewports.
- Independent disposable-database checks covered the 0001-to-0002 upgrade and preserved account access, signed 64-bit rate limits, zero and inherited rates, ownership, authentication and CSRF, stale revisions, duplicate IDs, and archive and restore with parent filtering. The validator inspected the client and project editors and lists on desktop and phone with no page errors or horizontal overflow.
- Astra reviewed the 17 changed source, test, and configuration files. The review caught a mismatch in Unicode length validation, which the backend author corrected and tested. Final review passed with no blocking findings. The reviewed file hashes matched the implementation at integration. The reviewed manifest SHA-256 is `c17ee5930016d26dec7997c3974b2a5be930cecf70ba977e009d478382110d33`.
- Browser checks used Chromium viewport emulation and a disposable SQLite database.

## Follow-up

When time entries are introduced, check for existing entries inside the project reassignment transaction. Validate association availability and snapshot the entry's assigned rate in the entry creation transaction. Historical entry and report workflows should resolve the current names using the retained client and project IDs and include archived records in historical filters.
