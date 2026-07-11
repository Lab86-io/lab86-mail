# Claude Code Opus prompt — Area Brief v2

You are the required Claude Code Opus UI implementation sub-agent working in
`/home/jjalangtry/repos/lab86-mail` on branch `staging`. Do not commit or push.

## Issue and acceptance criteria

This is a user-reported follow-up to GitHub issue #75, "Add Area navigation and
area lenses" (parent epic #69). The original #75 acceptance criteria remain in
force:

- A user can open an Area and see its related threads, tasks, events, MCP items,
  facts, projects, and unassigned/candidate context.
- Existing Smart categories remain usable.
- Verified versus candidate assignments remain explicit.
- Assignment correction remains available from the existing deeper surfaces.

Additional acceptance criteria from the July 11 user report:

1. The selected Area must visibly be an **Area Brief**, not a database dashboard
   with `Discuss` and `Manage` as its strongest ideas.
2. The generated `livingBrief.lede` and `livingBrief.summary` must be prominent
   when ready. Generating, error, and absent cached-brief states must remain
   honest and useful using live data; never fabricate progress.
3. The page should answer, in order: what matters now, what needs the user, what
   is moving, which Project/Epic owns multi-week work, and what evidence supports
   that understanding.
4. Projects/Epics and active Work must be visually distinct, with real progress,
   sprint, and state data only. Plans remain internal and must not return as a
   standalone destination.
5. Mail/events/tasks/context are evidence and supporting material. They must not
   overwhelm the brief simply because there are many rows.
6. Inline Area capture remains first-class but should feel integrated with the
   brief, not like a generic form dropped above a dashboard.
7. Dense desktop, narrow desktop, mobile, light/dark, keyboard, focus, reduced
   motion, loading, empty, brief-generating, brief-error, no-project, and no-work
   states must remain coherent.
8. The result must feel materially better and clearly different in hierarchy,
   composition, and interaction from the current screenshot.

## Product direction

Albatross is the verified intent layer across mail, calendar, tasks,
Projects/Epics, and future files. Artifacts are evidence, not intent. The user
tells Albatross what they are trying to get out of their head; Albatross asks one
material question at a time and creates Work, Projects/Epics, tasks, calendar
events, drafts, briefs, and completion history.

Area home is a living brief plus operational Work. Projects/Epics are a distinct
first-class primitive grouping multiple tasks and Work across weeks. Completion
inference is evidence, not truth. The current app design uses a dense editorial
grammar (Fraunces/Geist, OKLCH tokens, thin rules, compact rows); preserve that
identity without allowing "dense" to mean flat or visually timid.

The user supplied two staging screenshots. One valid Area page showed a thin
header with `Discuss`, `Refresh brief`, and `Manage`; a shallow bordered lead
stating the Area "has 17 filed signals to review"; a large capture input; empty
Work/Events; 17 mail rows dominating the page; and Context in a side column. The
user's accurate reaction was: "where's the area brief and the great UI?" A second
Area showed a full-page "This area is unavailable" state. Treat the first as a
hierarchy/design failure, not a copy tweak. The root agent is diagnosing the
query failure separately; make the error state more truthful but do not hide
backend errors by pretending an Area was archived.

## Current contracts to inspect before editing

- `components/albatross/AreaHome.tsx` — current selected Area and chooser UI.
- `lib/albatross/area-home.ts` — tested presentation helpers.
- `convex/albatross.ts` `areaHome` query — returns `area`, `livingBrief`, facts,
  mail, events, tasks, plans/Work, Projects/Epics, places, and counts.
- `lib/albatross/area-living-brief.ts` — generates and caches `{ lede, summary,
  status, generatedAt, basedOnRevision, error? }`; optional `error` is recorded
  when brief generation fails or saves an error state. Declared Work outranks
  artifact volume.
- `convex/albatrossWorkV2.ts` `areaWork` — returns operational Work rows.
- `components/albatross/WorkDetail.tsx` — Area Work drill-in.
- `components/shell/Rail.tsx`, `components/shell/AppShell.tsx`, and
  `lib/client-state.ts` — routing/selection; inspect but do not edit unless a UI
  integration change is strictly required.
- `tests/albatross-area-home.test.ts` and existing guardrail tests.
- `docs/albatross-development-contract.md` — mandatory.
- Prior grounding only (not a substitute for fresh research):
  `docs/albatross-area-brief-research.md`,
  `docs/albatross-area-brief-fit-notes.md`, and
  `docs/albatross-work-v2-ui-research.md`.

## Mandatory research before implementation

Before writing UI code:

1. Inspect 3–8 current Mobbin screens/flows for project/portfolio overview,
   status updates, AI work summaries, activity/evidence disclosure, and inline
   capture. At minimum investigate current Linear, Asana, Notion, ClickUp, Jira,
   or comparable products. Record exact screen IDs/links actually inspected.
2. Perform browser-based research using current product documentation or live
   public pages for at least three comparable patterns. Look specifically at how
   a generated summary coexists with live work and evidence, how status changes
   are surfaced, and how dense workspaces progressively disclose source rows.
3. Inspect the existing UI in code. T3 preview was attempted first by the root
   agent and returned `PreviewAutomationNoAvailableHostError` for both status and
   open. Use another available browser route for research/verification and record
   exact limitations. Do not claim screenshots you could not inspect.
4. Write the findings and design decisions to
   `docs/albatross-area-brief-v2-research.md` before finishing.

## UI direction

Design the page as an editorial, continuously updated brief—not a card grid and
not a source inbox:

- A clear Area identity/title and current brief edition/status.
- A strong living-brief lead using cached AI lede/summary when ready, with a
  quiet, concrete freshness/refresh affordance. The brief should read like the
  page's thesis, not one small card among controls.
- An explicit "Needs you" region that becomes the primary action queue when
  non-empty.
- Projects/Epics as durable multi-week structures with actual progress and
  active sprint; Work as smaller outcomes grouped by active/waiting/blocked/
  recently done.
- An integrated "Get this out of my head" Area capture affordance.
- Supporting evidence summarized by meaningful rollups/previews, with deliberate
  row caps and honest deep links. Avoid rendering 17 similar mail rows as the
  visual center of gravity.
- Context/candidate facts visibly distinguish verified from suggested.
- `Discuss` should be contextual, not the page's headline action. `Manage` should
  remain discoverable but secondary.
- The Area unavailable/error state must say the Area could not be loaded and
  offer retry/all Areas; do not assert it was archived unless the data says so.

Avoid generic gradients, decorative blobs, fake metrics, giant marketing type,
excessive pills, nested cards, meaningless icons, and hardcoded companies,
professions, or personal examples. Use animation only when it clarifies refresh,
expansion, progressive disclosure, or Work state; honor reduced motion.

## Allowed files

You may edit only:

- `components/albatross/AreaHome.tsx`
- `lib/albatross/area-home.ts`
- `tests/albatross-area-home.test.ts`
- `tests/albatross-guardrails.test.ts` if needed for a stable UI contract
- `docs/albatross-area-brief-v2-research.md`

Do not touch the four unrelated untracked prototype files at repository root.
Do not edit backend schema/query contracts. If you discover a required backend
change, document it for the root agent instead of making it.

## Verification

- Add or update focused tests for every new helper, render contract, state, or
  routing behavior touched. Prefer durable pure/helper or source-contract tests
  over brittle screenshots.
- Run focused tests, `bun run typecheck`, and targeted Biome checks.
- Use browser verification where available; record exact auth/tool constraints.
- Finish with a concise report: research, UX decisions, files changed, tests,
  browser verification, and backend/root-agent follow-ups.
