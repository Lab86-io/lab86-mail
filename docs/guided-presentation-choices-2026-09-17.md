# Guided presentation choices

## Product decisions

Presentation creation has three conversational checkpoints, with research between them:

1. Brief: audience, desired outcome, sources and scope, content-slide count, section breaks, and detail level.
2. Design: theme previews, font previews, and imagery direction. Show the actual title in previews when available.
3. Storyboard: inspect every proposed slide and choose among relevant chart/table/graphic representations, with evidence-based data previews. Confirm the outline or request revisions before creation.

Choices are returned through the existing durable chat tool-result path. A pending card pauses generation. Reopening the conversation preserves submitted choices and receipts. The final creation step uses the confirmed colors/fonts and slide/visual choices. Users may explicitly delegate choices; defaults must never submit themselves. Each checkpoint includes free-form guidance.

Theme, font and preview values share the presentation composition system. Preserve existing app density, colors, controls and typography around the cards. Previews retain the deck's own theme, independent of app dark mode. Use native buttons and fieldsets, visible focus, labeled numeric inputs, responsive cards, and an explicit continue action.

## Research

- Mobbin skill: `/home/jjalangtry/.codex/skills/mobbin-ui-research/SKILL.md`. Its `search_screens`/`search_flows` tools are unavailable. Browser inspection of [Mobbin's web discovery page](https://mobbin.com/discover/apps/web) exposed the public discovery/marketing surface, not inspectable presentation-picker screens. No specific Mobbin screen or flow is claimed as evidence.
- Browser inspection of [Pitch's template gallery](https://pitch.com/templates): visual slide snapshots communicate typography and color together. Use real slide previews rather than swatches alone.
- [Gamma theme selection](https://help.gamma.app/en/articles/10262646-how-do-i-change-my-gamma-theme): preview a theme on content before applying it. Keep theme selection reversible until the user continues.
- [Gamma's guided agent flow](https://help.gamma.app/en/articles/15002203-how-do-i-create-with-agent-in-gamma): clarify audience and goals with selectable answers plus free text, then review a plan; explicit delegation remains available. Apply this sequence to Albatross's existing pause-and-resume tool UI.
- Existing product: `HitlPart`, `QuestionFlowPart`, `AssistantChat`, the deck ThemePanel, and `SlideSurface`. Reuse chat persistence/continuation and the exact slide renderer. The collaborative preview host is unavailable; local Playwright and the actual-component preview server provide browser validation.

## Validation

- Full suite: 4,052 tests pass, one optional browser-render test skipped. Changed library files retain or improve baseline line coverage; the new choice/session module has 100% line coverage.
- Focused behavior: pending/cancel/revise/delegate, malformed and stale responses, exact slide counts and order, theme/font enforcement, data-preserving chart/table changes, long saved answers, bounded source notes, workbook availability, planner context and one-time continuation.
- All 48 theme/font combinations pass composition, contrast and export-font checks. Sand and Slate muted colors were adjusted after the contrast checks caught their surface-panel labels.
- Actual-component browser flow at 1200px and 390px (dark): audience/scope/pacing, eight theme previews, six font previews, keyboard selection, chart-data comparison, final storyboard confirmation and reload. No browser errors or horizontal overflow. Reproduce with `NARRATIVE_PREVIEW_PORT=18852 bun scripts/preview-narrative-tools.mjs --presentations`, then `bun scripts/verify-presentation-choices-ui.mjs`.
- Local screenshots are in `/tmp/presentation-choice-qa/`, including the surrounding actual app workspace. Synthetic data is explicitly labeled; browser acceptance does not claim a live account/model generation run.
- Typecheck, lint and production build pass. Lint retains the repository's existing unrelated warning/info. CI and the staging deployment workflow verify the merged release.

## Scope and limits

Submitted choices persist through normal chat history. Unsubmitted form edits are local to the mounted card. Explicit delegation is available at every checkpoint. Charts are offered only when supplied data supports them; the agent remains responsible for retrieving and verifying the source evidence. PowerPoint uses the existing Office-compatible font substitutions; web and rendered slide previews use the packaged selected fonts.
