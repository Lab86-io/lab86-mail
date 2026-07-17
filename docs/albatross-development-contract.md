# Albatross Development Contract

This contract applies to every Albatross 0.9 issue and every future issue that changes Albatross behavior or UI.

## UI Implementation Rule

Codex or another assigned implementation agent may design and implement Albatross UI directly. For every material UI change:

1. Start from the exact issue and acceptance criteria.
2. Inspect the existing surface, adjacent states, and current design-system patterns before editing.
3. Preserve the established app density, visual language, accessibility, and interaction conventions unless the issue explicitly changes them.
4. Inspect relevant Mobbin examples and use browser-based product research before materially changing a UI surface. Straightforward copy-only or non-visual behavior changes do not require fresh research.
5. Add or update focused tests for every behavior, state, routing, or data contract touched.

Keep a concise research note for material UI changes and cite it in the PR summary. Include the Mobbin screens/flows used, browser-based references, and any unavailable-tool constraints. Do not claim research that was not performed.

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

## Albatross UI Research Baseline

Use fresh research for every material UI issue. These products are reasonable starting points for the Areas, Intents, and Unassigned surfaces:

- Areas/dashboard patterns: ClickUp, Wrike, and Asana screens on Mobbin; Notion Projects and Asana project-management pages for view switching, status rollups, connected docs, and portfolio/task grouping.
- Intent/planning patterns: ClickUp, Sana AI, and Plane screens on Mobbin; GTD-style capture and review guidance from Todoist for inbox, next actions, waiting-for, and weekly review structure.
- Unassigned/review patterns: Intercom and Pipedrive screens on Mobbin for dense review queues, assignment decisions, ownership, and side-panel triage.
