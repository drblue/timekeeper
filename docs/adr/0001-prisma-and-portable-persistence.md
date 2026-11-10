# Prisma with SQLite initially and explicit database migration targets

Status: accepted — 2026-11-10

Use Prisma 7 with SQLite for the initial single-user deployment, keeping PostgreSQL and MariaDB as tested migration targets. Drizzle was considered for its TypeScript schemas and SQL control; Prisma was selected because a relatively uniform client model and explicit MariaDB support better fit the required portability, while SQLite avoids a separate database service on the Pi.

Portability does not mean reusable SQL migrations or an automatic connection-string switch: retain provider-specific schemas/migration histories, isolate persistence from domain rules, and transfer and verify data explicitly. Major Prisma upgrades must preserve support for all required engines. See the [technical design](../technical-design.md) for the transfer procedure and validation gates.
