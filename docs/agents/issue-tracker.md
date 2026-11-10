# Issue tracker: GitHub

Track implementation tickets in GitHub Issues for drblue/timekeeper.
The product specification and technical design remain repository documents.

## Operations

- Use the gh CLI from this repository, explicitly targeting drblue/timekeeper.
- Verify the target with gh repo view before publishing.
- Read an issue's full body, labels, and comments before working on it.
- Create one issue per approved ticket. Use --body-file for multiline bodies.
- Apply the configured triage label when publishing.
- Link child tickets using native GitHub sub-issues when a parent exists.
- Record blockers using native GitHub issue dependencies.
- If native relationships are unavailable, use explicit parent/blocker references in issue bodies.
- When using the API for relationships, use issue database IDs, not issue numbers or node IDs.
- A ticket is startable only when all blockers are closed.
- Posting comments, closing issues, or modifying parent issues requires authorization from the active task or explicitly invoked skill.
- Never publish project tickets to the skills author's repository.

Use installed gh commands where supported; otherwise use gh api for native sub-issue and dependency operations.

## Pull requests as a triage surface

PRs as a request surface: no.

## Skill routing

“Publish to the issue tracker” means create a GitHub issue.
“Fetch the relevant ticket” means read its body, labels, and comments.

For wayfinding, use a map issue labeled wayfinder:map and linked child issues labeled by type: wayfinder:research, wayfinder:prototype, wayfinder:grilling, or wayfinder:task. Create these additional labels only when that workflow is invoked.
