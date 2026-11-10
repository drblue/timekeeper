# Timekeeper

A single-user time-tracking application for recording work, tracking billable amounts and external invoicing, importing Clockify data, and exporting PDF time reports.

The initial application runs the browser interface and its liveness API from one Fastify process. Time tracking, persistence, account access, browser installation, and deployment are planned in the product specification.

## Run locally

Use Node.js 24.19.0 and npm 11.17.0. If you use nvm, run `nvm install` and `nvm use` from the repository root.

```sh
npm ci
npm run build
npm start
```

Open [Timekeeper](http://127.0.0.1:3000) and select **Check connection** to repeat the same-origin API request. The production process serves the compiled web files from `apps/web/dist`. Set `HOST` and `PORT` to override the defaults of `127.0.0.1` and `3000`.

For development, run `npm run dev:server` and `npm run dev:web` in separate terminals. Open [the Vite development server](http://127.0.0.1:5173). Vite forwards API requests to the local Fastify process. If you change `PORT`, use the same value in both terminals. Restart the development server after editing the shared contracts to rebuild that workspace.

## API

- `GET /api/v1/health` returns `200` with `{"status":"ok"}` when the API process can serve requests. It accepts no query parameters and has no database or account dependencies.
- `GET /api/v1/openapi.json` serves the OpenAPI description generated from the Fastify route schemas.

TypeBox defines shared JSON Schema and TypeScript types in `packages/contracts`. Fastify validates incoming requests and validates schema-defined responses before sending JSON. Structured errors include `code`, `message`, and a server-generated `requestId`, plus `fieldErrors` for request validation failures.

## Checks

```sh
npx playwright install chromium --only-shell
npm run check
```

Run `npm run typecheck`, `npm test`, or `npm run test:e2e` individually. The browser tests build and start the production service and verify the connection and recovery flow in desktop and phone viewports. The smoke test needs local port `4317` available.

Run `npm run test:persistence` with local Docker Compose to check the persisted-data fixture against SQLite, PostgreSQL, and MariaDB. Run `npm run test:persistence -- sqlite` for SQLite alone without Docker, or `npm run typecheck:persistence` to check the fixture types. The [portability handoff](docs/hand-offs/issue-2-implementation.md) records the tested versions, database isolation, and architecture checks.

## Documentation

- [Product specification](docs/specification.md): agreed behavior and acceptance scenarios.
- [Technical design](docs/technical-design.md): architecture, data model, API boundaries, calculations, deployment, and migration procedures.
- [Persistence decision](docs/adr/0001-prisma-and-portable-persistence.md): why Prisma and SQLite were selected, with PostgreSQL and MariaDB as migration targets.
- [Glossary](GLOSSARY.md): domain terminology.
- [Implementation tickets](docs/implementation-tickets.md): published GitHub issues and initial dependencies.
- [Discovery notes](docs/discovery.md): confirmed interview decisions and scope history.

## Selected stack

React/Vite with TanStack Router and Query; Node.js/Fastify; Prisma 7 with SQLite initially; Docker Compose for ARM64 Raspberry Pi and x86-64 VPS hosting. Preserve PostgreSQL/MariaDB portability; full transfer tooling is optional future work and must be verified if pursued. Server-side pdfmake is selected for PDF reports. Native desktop/iOS clients remain future work against the same API. [PDF renderer decision](docs/adr/0002-pdfmake-for-time-reports.md)

## Agent workflow

[AGENTS.md](AGENTS.md) routes engineering skills to the GitHub tracker, default triage labels, and domain documentation. [Implementation coordination](docs/agents/implementation.md) defines focused agent assignments, model selection, and independent validation/review. Configuration under `docs/agents/` can be edited directly; rerun setup only when changing tracker or restarting configuration.
