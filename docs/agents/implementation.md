# Coordinated implementation and independent review

## Roles and model selection

A coordinator owns scope, dependencies, assignments, integration, and acceptance evidence. Separate agents perform focused implementation, validation, and code review. Assign only tickets whose blockers are complete; parallelize independent tickets when their edit ownership does not overlap.

Select from models actually available in the session. Default assignments:

| Work | Model | Reasoning |
| --- | --- | --- |
| Routine implementation | gpt-6.1-sol | medium |
| Money/time rules, import identity, migrations, concurrency | gpt-6.1-sol | high |
| Independent validation | gpt-6.1-terra | medium; high for complex invariants |
| Independent code review | gpt-6-astra | high |

These are assignment defaults, not a dependency on model names being permanently available. Record the actual model and reasoning level in each handoff. Select an equivalent available model when needed, while preserving model independence. If no different model is available for validation/review, report the missing gate instead of treating same-model review as independent.

The validation and review models must each differ from every model that authored the code under assessment; using a fresh agent with the same model is not sufficient. An implementer may run tests, but those results do not replace independent validation. If a validator/reviewer writes fixes, that changed code needs validation/review by a different model too. Prefer returning findings to the implementer to preserve clear authorship.

## Focused sessions

- Give each implementation agent one bounded ticket or explicitly scoped subtask, acceptance criteria, relevant decisions, edit ownership, base revision, and blocker outcomes.
- Prefer fresh agents with concise handoff context over inheriting the full coordinator conversation. Read only the source documents and code relevant to the task.
- Stop at a coherent milestone: implemented slice, completed validation, review findings, or a concrete blocker. Start a fresh session when the next phase would otherwise accumulate unrelated context.
- Persist a short handoff: ticket, branch/revision, actual model/reasoning, changes, checks and outcomes, unresolved risks, and next action. Use the ticket or PR when posting is authorized; otherwise use the local coordination artifact.
- Keep review/fix cycles bounded to the findings. If scope expands, split work explicitly instead of growing one session indefinitely.

## Integration gate

1. Implementer delivers a demoable slice with relevant tests and a handoff.
2. Independent validator checks acceptance criteria, including failures and edge cases, against the actual revision. Record what was run and what remains unverified.
3. Independent reviewer inspects the diff, domain invariants, security/data risks, and test adequacy. Tie findings to the reviewed revision.
4. Coordinator routes fixes back, obtains targeted revalidation/review on changed behavior, and integrates only after blocking findings are resolved. Recheck integration-sensitive behavior after combining parallel work.
5. Record final revision and evidence before marking work complete. Hardware-dependent performance, PDF appearance, and restoration checks need their actual evidence; passing unit tests cannot substitute for them.

Use isolated worktrees when concurrent changes could collide, following workspace worktree rules. In a shared checkout, serialize edits/commits and agree file ownership before parallel work. Do not let one agent commit another agent's unfinished changes.
