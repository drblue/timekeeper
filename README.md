# Timekeeper

A single-user time-tracking application for recording work, tracking billable amounts and external invoicing, importing Clockify data, and exporting PDF time reports.

The project is currently in design. Application code and deployment are not implemented yet.

## Documentation

- [Product specification](docs/specification.md): agreed behavior and acceptance scenarios.
- [Technical design](docs/technical-design.md): architecture, data model, API boundaries, calculations, deployment, and migration procedures.
- [Persistence decision](docs/adr/0001-prisma-and-portable-persistence.md): why Prisma and SQLite were selected, with PostgreSQL and MariaDB as migration targets.
- [Glossary](GLOSSARY.md): domain terminology.
- [Discovery notes](docs/discovery.md): confirmed interview decisions and scope history.

## Selected stack

React/Vite with TanStack Router and Query; Node.js/Fastify; Prisma 7 with SQLite initially; Docker Compose for ARM64 Raspberry Pi and x86-64 VPS hosting. PostgreSQL and MariaDB transfer paths must be verified. React PDF is provisional pending report-layout and resource evaluation. Native desktop/iOS clients remain future work against the same API.

## Agent workflow

[AGENTS.md](AGENTS.md) routes engineering skills to the GitHub tracker, default triage labels, and domain documentation. [Implementation coordination](docs/agents/implementation.md) defines focused agent assignments, model selection, and independent validation/review. Configuration under `docs/agents/` can be edited directly; rerun setup only when changing tracker or restarting configuration.
