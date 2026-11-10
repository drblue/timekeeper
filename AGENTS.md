# Agent Instructions

## Working agreements

- Prefer TypeScript and ESModules.
- Use tabs for indentation.
- Confirm new production dependencies unless necessary and clearly implied by the task.
- Commit completed changes on dev or a feature branch, never directly on main.
- Write commit messages and documentation in English.

## Agent skills

### Issue tracker

Use GitHub Issues in drblue/timekeeper. Read docs/agents/issue-tracker.md before reading, creating, or updating tickets.

### Triage labels

Use the five default triage labels. Read docs/agents/triage-labels.md when labeling or selecting tickets.

### Domain docs

Use the single-context glossary and ADR layout. Read docs/agents/domain.md before domain or implementation work.

### Coordinated implementation

Build through a coordinator and separate focused agents. Read docs/agents/implementation.md before assigning implementation, validation, or review. Validation and code review must use a different model from the implementation author.
