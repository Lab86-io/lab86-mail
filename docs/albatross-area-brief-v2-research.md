# Albatross Area Brief v2 — research & design decisions

**Model:** Claude Opus (required Albatross UI sub-agent, per `CLAUDE.md` /
`docs/albatross-development-contract.md`).
**Date:** 2026-07-11.
**Issue:** follow-up to GitHub #75 ("Add Area navigation and area lenses",
parent epic #69), driven by a July 11 user report on a staging screenshot.

## The failure being fixed

The user opened a valid Area and saw a database dashboard, not a brief: a thin
header whose strongest ideas were `Discuss` and `Manage`; a shallow bordered
lead reading "<Area> has 17 filed signals to review"; a large capture form; empty
Work/Events; and **17 mail rows as the visual center of gravity**, with Context
in a side column. Their reaction — "where's the area brief and the great UI?" — is
a hierarchy/composition failure, not a copy tweak. A second Area rendered a
full-page "This area is unavailable" that wrongly asserted it "may have been
archived or removed in Settings" when the real cause is a backend query error the
root agent is diagnosing separately.

Three concrete root causes in the current code:

1. **The generated brief is invisible unless perfect.** `convex/albatross.ts`
   `areaHome` returns the whole `livingBrief` doc (`status`, `lede`, `summary`,
   `generatedAt`, `error`, `basedOnRevision`), but `AreaHome.tsx` only renders
   `lede`/`summary` when `status === 'ready'`. The `generating` and `error`
   states — and any last-known brief during them — never reach the screen, so the
   page falls back to a deterministic one-liner and looks like it has no brief.
2. **Evidence outranks intent.** Mail/events/tasks render at the same weight as
   (and above) Work and Projects, so a noisy mailbox buries the thesis.
3. **The header leads with the wrong verbs.** `Discuss` and `Refresh brief` are
   full header buttons; the brief itself is one small bordered card among them.

## Mandatory research

### Mobbin (platform: web, inspected 2026-07-11)

- **Asana — project overview, "generate summary" empty state**
  ([0f8c5ba7-03c4-4efc-82c3-ac316c64432f](https://mobbin.com/screens/0f8c5ba7-03c4-4efc-82c3-ac316c64432f)):
  when no summary exists, the overview shows a titled "AI summary" block with
  "Recent activity" / "Risk report" toggles and a single **Generate summary**
  action — never a fabricated summary. Grounds our **absent** brief state: show
  the deterministic headline plus one quiet generate/refresh affordance, never
  invented prose.
- **Asana — project overview, generated status update**
  ([140afee3-90ed-4459-b057-c17cf06b84e7](https://mobbin.com/screens/140afee3-90ed-4459-b057-c17cf06b84e7)):
  a generated "Project Status Report" summary sits in the right rail beside a
  live **On track** pill and a "Status update posted / Asana AI has finished
  preparing your status update" toast. Grounds a generated summary **coexisting
  with a live state indicator and a freshness signal**, and the honest
  "generating → ready" transition.
- **Asana — overview with AI summary + Recent activity + Risk report**
  ([91b6ac7f-bcb5-48ef-bede-fe61fef3a8e0](https://mobbin.com/screens/91b6ac7f-bcb5-48ef-bede-fe61fef3a8e0)):
  the summary is the page thesis; activity/risk are disclosed beneath it, not
  competing with it. Grounds **brief-as-thesis, evidence-as-support** ordering.
- **Linear — project Updates tab**
  ([ed6163fd-12f3-4aad-a6ed-62707cb7c21e](https://mobbin.com/screens/ed6163fd-12f3-4aad-a6ed-62707cb7c21e)):
  a latest update with an **On track** chip and "Progress since <date>" milestone
  rows in the main column, while **Properties / Milestones / Progress** live in a
  right rail. Density from typography, not boxes. Grounds the **main narrative +
  compact side dossier** split and per-project progress rows.
- **Contra — project detail with "Next step" callout + activity timeline**
  ([1968548c-f02b-4b16-a755-fb57a5a9ba09](https://mobbin.com/screens/1968548c-f02b-4b16-a755-fb57a5a9ba09),
  [4785e339-1a89-4a11-a28d-e485cd1273e0](https://mobbin.com/screens/4785e339-1a89-4a11-a28d-e485cd1273e0)):
  a single **Next step** panel with one primary action leads, a **Pre-launch
  checklist** shows real state, and the activity feed is a quiet supporting
  timeline. Grounds the **"Needs you" queue as the one primary action region**
  and evidence as a quieter band below.
- **ClickUp / Asana — list grouped by status with counts**
  ([8b2419a3-f16a-4a36-8269-871829c24f8c](https://mobbin.com/screens/8b2419a3-f16a-4a36-8269-871829c24f8c),
  [8935ad31-7dde-44dc-9aa6-7970e66f0312](https://mobbin.com/screens/8935ad31-7dde-44dc-9aa6-7970e66f0312)):
  work grouped by state (In development / In research / Done…) with a per-group
  count. Grounds **Work grouped active / waiting / recently done**.
- **Obvious / Linear — one calm capture line heads the workspace**
  ([0ff79563-f85d-4452-bd59-286142c09bbe](https://mobbin.com/screens/0ff79563-f85d-4452-bd59-286142c09bbe),
  [37054da5-16ca-474e-88a7-7d49e339d1bc](https://mobbin.com/screens/37054da5-16ca-474e-88a7-7d49e339d1bc)):
  a single quiet prompt line, not a heavy multi-control form. Grounds the
  **integrated capture line** rather than a boxed form dropped above a dashboard.

### Browser-based product research (2026-07-11)

- **Linear — Project overview docs**
  ([linear.app/docs/project-overview](https://linear.app/docs/project-overview),
  fetched): the overview is a **document** — short summary, then editable
  properties beneath it, then resources, description, and milestones; the details
  **sidebar** mirrors properties/documents and holds the live predictive
  **project graph**. Confirms narrative-first main column + properties/progress
  rail.
- **Linear — Agent-assisted project updates changelog**
  ([linear.app/changelog/2026-06-18-agent-assisted-project-updates](https://linear.app/changelog/2026-06-18-agent-assisted-project-updates),
  fetched): an agent "reviews changes since the last update … and writes an
  update **draft** for you to refine," then publish. Confirms the generated brief
  is an editable/refreshable draft with an explicit generate action and a
  draft→published lifecycle — never silently authoritative.
- **Notion — Getting started with projects and tasks**
  ([notion.com/help/guides/getting-started-with-projects-and-tasks](https://www.notion.com/help/guides/getting-started-with-projects-and-tasks),
  fetched): projects are parents of tasks; progress is an **auto-calculated
  completion bar**; detail is **nested inside records and disclosed on open**,
  and views filter to "only relevant subsets" rather than flattening everything.
  Confirms real progress from counts (no fake metrics) and **progressive
  disclosure of source rows** behind caps + deep links.

### Browser tooling constraints (recorded honestly)

- T3 preview was attempted by the root agent and returned
  `PreviewAutomationNoAvailableHostError` for both status and open; no T3
  screenshot was available.
- The `browserbase` MCP is **not connected in this session** (only `nylas`,
  `railway`, `shadcn`, `mobbin`, `granola-statpearls`, `figma`, `atlassian-rovo`,
  `cloudflare`, `sevalla` are). The shell `browserbase-fetch` does not execute
  JavaScript, so SPA doc pages (Linear, some Asana) returned unusable markup or
  Cloudflare interstitials; `asana.com/inside-asana/...` 404'd. Text-clean
  product docs were read via the harness `WebFetch` route instead, recorded
  above. No live authenticated screenshot of the Area Brief was captured.
- Exact verification on the final implementation:
  - `bun test tests/albatross-area-home.test.ts tests/albatross-area-query-bounds.test.ts tests/albatross-area-brief-route.test.ts tests/albatross-guardrails.test.ts`
    — **113 passed, 0 failed** at the final focused run.
  - `bun run typecheck` — **passed** (`tsc --noEmit`).
  - `bun run lint` — **passed** (Biome checked 526 files, no fixes).
  - `bun run test:coverage` — **1,019 passed, 0 failed** across 95 files.
  - `bun run build` — **passed** (Next.js production compilation,
    TypeScript, page-data collection, and static generation completed).
- Backend/root-agent follow-ups resolved the Personal Area failure as a Convex
  timeout caused by an unbounded artifact-link read. The final bounded query
  was deployed to the development Convex deployment and verified against the
  real Personal Area: **195 documents read in ~200 ms**, with a ready generated
  living brief. The old path read 26,243 documents and timed out. Per-kind and
  board-card scans now use sentinel rows and newest-first indexes; no known
  Area Home query failure remains.
- Root-agent review also added the real authenticated refresh route, explicit
  ownership point lookup, best-effort reindex-before-generation sequencing,
  safe error responses, bounded-count labels, complete/qualified Needs-you
  presentation, and focused executable route/query/state tests. CodeRabbit was
  rerun after each follow-up. Screenshot verification remains unavailable only
  because no automation-capable T3 preview host was attached.

## Design decisions

Ordered to answer the page's five questions in the criterion-3 sequence: **what
matters now → what needs you → what is moving → which Project/Epic owns the
multi-week work → what evidence supports it.**

1. **Thin header, secondary controls.** Breadcrumb → area mark → title → kind →
   index-status pill. `Refresh brief` becomes a quiet icon-light control;
   `Discuss` moves out of the headline into a contextual "Ask about this area"
   affordance attached to the brief; `Manage` stays a quiet secondary link. No
   verb competes with the brief for the eye.
2. **Brief as thesis, with honest states.** A new pure resolver `areaBriefState`
   turns the `livingBrief` doc into one of four honest modes — **ready**
   (editorial serif lede + summary + "Updated <freshness>"), **generating** (last
   known text, if any, under a reduced-motion-safe "Updating…" cue; otherwise the
   deterministic headline and an honest "Writing the brief…"), **error** (last
   known text with "Couldn't refresh — showing the last brief" + retry; otherwise
   the deterministic headline and "Live work and evidence are below"), and
   **absent** (deterministic headline + one quiet "Generate brief" action). Never
   fabricate progress; never hide the backend state.
3. **Integrated capture.** One quiet "Get this out of your head" line directly
   under the brief, in the editorial voice — a capture input that creates a real
   area-bound intent and hands off, not a heavy form and not a chatbot.
4. **Needs you = the one action queue.** `areaNeedsYouRows` is extended (new pure
   helper `workNeedsYouRows`) to fold in Work items whose `agentState` is
   `needs_input`, so there is a single authoritative "Needs you" region that
   becomes primary when non-empty; Work sections no longer render a duplicate
   needs group.
5. **Work grouped by momentum.** Active / waiting-blocked / recently-done, each a
   dense typographic group with a state dot and count.
6. **Projects & Epics visually distinct.** Rendered heavier than Work rows — real
   completion bar (`projectProgress`, divide-by-zero-safe), active sprint, and
   state chip (`projectStateMeta`) — only from real data. Plans have no
   standalone destination; a project links back to its source Work when one
   exists.
7. **Evidence is a quieter supporting band.** A single "Evidence" super-header
   with a one-line rollup (`evidenceRollup`, non-zero facets only) precedes tight
   previews (mail/events/tasks capped low so a 17-thread mailbox can no longer
   dominate) plus the places/context dossier. Verified vs suggested stays
   explicit via the `Suggested` tag; candidate facts keep verify/reject.
8. **Truthful unavailable state.** "This area couldn't be loaded." + **Try
   again** (remount/re-query) + **All areas**. No archival claim.

### Anti-patterns explicitly avoided (per `docs/albatross-voice-and-style.md`)

Removed the `Sparkles` icon and all icon-before-text stat chips (hard taste
rule); no ALL-CAPS micro-labels; no gradients, blobs, fake metrics, nested cards,
or hardcoded example companies/professions. Animation is limited to refresh /
progressive-disclosure / Work-state cues and honors `prefers-reduced-motion` via
Tailwind `motion-reduce:` variants.

## Tests

New pure helpers are unit-tested in `tests/albatross-area-home.test.ts`:
`areaBriefState` (all four modes + stale-content carry-through), `areaFreshness`
(just now / hours / older date), `workNeedsYouRows` (only `needs_input`, carries
`workId`, cap), `projectProgress` (clamp + divide-by-zero), `projectStateMeta`,
and `evidenceRollup` (non-zero facets, singular/plural). Existing helper tests
remain green.
