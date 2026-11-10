# Domain documentation

This repository uses one domain context, regardless of its planned frontend/server workspace layout.

## Read before working

- GLOSSARY.md: canonical domain vocabulary.
- Relevant decisions under docs/adr/.
- docs/specification.md: required product behavior.
- docs/technical-design.md: architecture and implementation constraints.

If a glossary or ADR is absent, proceed without creating placeholders. Create domain documentation when terminology or decisions are resolved.

## Conventions

Use glossary terms in tickets, code, tests, and documentation. Identify meaningful terminology gaps for domain modeling.

Surface conflicts with existing ADRs explicitly; do not silently override an accepted decision.

Keep implementation details out of the glossary. Record consequential architectural tradeoffs in ADRs.
