# Albatross Development Contract

This contract applies to every Albatross 0.9 issue and every future issue that changes Albatross behavior or UI.

## UI Generation Rule

If an issue designs or materially changes a UI component, all three conditions must be true before code is written:

1. The UI component must be implemented either directly by 5.6-sol or by a Claude Code sub-agent using Opus.
2. The implementation scope must name the UI to design, the files to edit, the product constraints, and the acceptance criteria. For the Claude path, provide this scope in a full-context prompt, e.g. `claude -p "{prompt}" --model opus`. The 5.6-sol path does not require a sub-agent.
3. Both paths must perform fresh Mobbin plus browser-based research for comparable UIs, UX flows, and animation/interaction grounding before implementation.

Do not use tiny prompts, no-tool prompts, or lightweight model fallbacks for Albatross UI implementation. When the Claude path is chosen, Opus work can take a while; let the full tool-enabled run complete unless it clearly errors.

The implementation scope, and the Claude prompt when that path is chosen, must include:

- The exact issue number and acceptance criteria.
- The files the sub-agent may edit.
- The surfaces, states, and workflows to design.
- The requirement to inspect Mobbin examples.
- The requirement to use browser-based product research.
- The available research links/findings already gathered, without replacing Claude's own research requirement.
- The requirement to preserve the existing design system and app density.
- The requirement to add or update tests for every behavior, state, routing, or data contract touched.

The PR summary must include:

- The implementation path and model used (5.6-sol direct or Claude Code Opus).
- For the Claude path, the sub-agent prompt or a concise linkable summary of it.
- Mobbin screens/flows used as grounding.
- Browser-based references used as grounding.
- Any research constraints or unavailable tools.

## Implementation Quality

Tests cannot regress. Every issue must leave `bun run lint`, `bun run typecheck`, relevant focused tests, and any affected integration tests passing before review.

When implementation touches shared contracts, add focused tests for:

- Feature flags and disabled-state behavior.
- Persisted client-state migrations.
- Routing or navigation visibility.
- Convex schema/function contracts.
- API/auth behavior.
- UI state and render contracts that can be tested without brittle screenshots.

## Per-Issue GitHub Workflow

For each GitHub issue resolved by Albatross work:

1. Work from an Albatross branch/worktree.
2. Push the increment to a PR targeting `staging`.
3. Add the resolved issue to the PR summary.
4. Add `Resolves #ISSUE_NUMBER` or `Closes #ISSUE_NUMBER` to the PR references.
5. Move the project item to `In review`.
6. Request a CodeRabbit review on the increment.
7. Loop on CodeRabbit and human review comments until addressed.
8. Mark resolved review comments as resolved in the PR.
9. Keep tests green after every review-change loop.
10. Once the PR increment is accepted/merged, mark the issue as `Done` in the project.

The issue should not be considered complete until code, tests, PR metadata, review, and project-board movement are all complete.

## Current Albatross UI Research Baseline

Use fresh research for every UI issue. As initial grounding for the Areas, Intents, and Unassigned surfaces:

- Areas/dashboard patterns: ClickUp, Wrike, and Asana screens on Mobbin; Notion Projects and Asana project-management pages for view switching, status rollups, connected docs, and portfolio/task grouping.
- Intent/planning patterns: ClickUp, Sana AI, and Plane screens on Mobbin; GTD-style capture and review guidance from Todoist for inbox, next actions, waiting-for, and weekly review structure.
- Unassigned/review patterns: Intercom and Pipedrive screens on Mobbin for dense review queues, assignment decisions, ownership, and side-panel triage.
