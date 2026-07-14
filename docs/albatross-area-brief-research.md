# Albatross Area Brief — research & implementation notes

**Model:** Claude Opus 4.8 (required Albatross UI sub-agent, per `CLAUDE.md` /
`docs/albatross-development-contract.md`).
**Date:** 2026-07-09.
**Issue:** N/A — no GitHub issue number was provided with this task. This is a
documented limitation: the increment was specified directly in the prompt with
acceptance criteria rather than tracked against an issue. Future work on the
Area Brief should open an issue so the surface has a durable home for follow-ups.

## Prompt (verbatim scope)

Turn the Areas route's selected-area view into an **Area Brief home**: an area
pulse plus meaningful sections for needs-you, active plans, projects, places,
upcoming, and evidence/context. Requirements:

1. Area-bound plans render inside the brief from real intent/plan data. Keep
   `PlansSurface` — do not remove it.
2. Honest affordances to deeper surfaces (plan/intents, mail, calendar, tasks,
   project) — no broken links.
3. Grounded places extracted from `plan.places` / `mapQuery` / question option
   addresses, shown as compact place cards with external map links.
4. An area-scoped prompt/capture bar that creates an albatross intent with
   `source=chat` and `areaId`, and may switch to the existing intents view — no
   fake chatbot.
5. Preserve the design system: dense, work-focused, no marketing hero, no nested
   cards, no decorative blobs/orbs, no one-note purple/blue palette.
6. Focused tests; a research doc (this file).

Allowed files: `components/albatross/AreaHome.tsx`, `lib/albatross/area-home.ts`,
`tests/albatross-area-home.test.ts`, `convex/albatross.ts`, this doc, and only if
necessary `components/shell/AppShell.tsx` / `lib/client-state.ts`.

## Research

Mobbin MCP was **available** and queried on 2026-07-09 (platform: web). Browser
references were cross-checked against these curated product screens rather than
live-fetched (the Mobbin captures are the primary, higher-signal source for
this UI work). Screens inspected:

- **Jira — project Summary**
  ([mobbin.com/screens/c5cce2bb-e4c3-4ef3-baeb-97e9c09e6c1a](https://mobbin.com/screens/c5cce2bb-e4c3-4ef3-baeb-97e9c09e6c1a)):
  "Good morning, Sam Lee" greeting → a quiet pulse (`0 done · 12 updated ·
  12 created · 1 due`) → meaning-first sections (Status overview, Recent
  activity, Priority breakdown). Confirms the **pulse-first** read. We take the
  pulse but render it as a single dot-separated line, not a row of stat tiles —
  tiles would be nested cards.
- **Linear — project overview**
  ([mobbin.com/screens/e88b6bd7-3d4b-4e1e-8cd7-a9d2a6852795](https://mobbin.com/screens/e88b6bd7-3d4b-4e1e-8cd7-a9d2a6852795)):
  plan-as-document — title, outcome text, a properties row, "Progress since
  <date>" milestone rows, an activity rail. Density from typography, not boxes.
  Drives the **Plans** section: each plan is a typographic row with a status
  tone badge and its outcome/summary line, not a card.
- **Asana — project overview**
  ([mobbin.com/screens/a54b6fcb-93c7-4a3d-b25d-30e434916a0c](https://mobbin.com/screens/a54b6fcb-93c7-4a3d-b25d-30e434916a0c)):
  Connected Goals, Key resources, Milestones with an inline "Add milestone…"
  capture row, and a right-rail status/activity feed. Validates **inline capture
  living inside the brief** rather than behind a modal.
- **Asana — AI side panel**
  ([mobbin.com/screens/fc214162-cbcd-4ca4-ae4f-2f49299053b3](https://mobbin.com/screens/fc214162-cbcd-4ca4-ae4f-2f49299053b3)):
  the assistant is a side panel beside the work, not a takeover. Reinforces
  criterion 4: the capture bar is a **capture input that hands off to Plans**,
  not a chatbot.
- **Cycle / Fibery / Fabric home**
  ([Cycle](https://mobbin.com/screens/704837ed-6c33-431b-9bd7-5e7b335d0af9),
  [Fibery](https://mobbin.com/screens/b055ccb8-1b35-45c5-94f2-fe466a7ec28d),
  [Fabric](https://mobbin.com/screens/52db6a1a-55b0-4503-b150-929bc69d521f)):
  a workspace home leads with a single prompt/search line and grouped dense
  sections ("My Work" started/not-started/finished). Confirms the **one capture
  line at the top + grouped sections** structure and the **"needs you" queue**.

Product references corroborating the same patterns (Notion Projects/teamspace
home, Linear project pages, Asana project overview, Slack Canvas context pane,
Motion/Reclaim/Sunsama daily planners): all lead with what-needs-me, keep plans
as documents, and treat capture as a first-class line — none use a marketing
hero or decorative orbs on an operational home. Our brief follows suit.

## Implementation

Most of the read-model and pure-helper scaffolding already existed in the
working tree from the prior round; this increment wired the **render** and the
**capture handoff**, and added tests + this doc.

### `lib/albatross/area-home.ts` (pure, unit-tested)

- `areaPulse` — the one-line pulse; only non-zero facets in a fixed order
  (needs-you, plans, projects, places, upcoming), singular/plural aware.
- `areaNeedsYouRows` — the "needs you" queue: plan-answers first (they stall the
  whole plan), then overdue incomplete tasks, then candidate context to confirm;
  bounded by a cap; tolerant of null inputs.
- `planStatusMeta` / `planActionLabel` — one status tone + one next-move verb per
  plan row; `needs_answers` outranks the intent's own status.
- `intentDisplayTitle` — a stable, never-empty one-line plan title.
- `extractAreaPlaces` / `mapsSearchUrl` — grounded places only: structured
  `plan.places` first, a plan's `mapQuery` as a fallback place, then answer
  options **that carry a real address** (never a free-text option). Deduped by
  name, capped, each with a Google Maps search URL.

### `convex/albatross.ts` — `areaHome` query

Indexed, bounded, user-scoped reads. Adds to the existing mail/events/tasks/
facts payload:

- `plans` — the area's active intents (status ≠ done/archived) plus their latest
  owned plan, from a bounded recency scan filtered by `areaId` in memory
  (intents carry `areaId` as a plain string).
- `projects` — `albatrossProjects` via the `by_user_area` index, active/paused,
  recency-sorted and capped.
- `places` — derived server-side via `extractAreaPlaces` from plan places /
  mapQuery / intent question options.
- `counts` extended with `plans`, `projects`, `places`.

### `components/albatross/AreaHome.tsx`

The selected-area view is now the Area Brief:

- **Pulse strip** — `PulseStrip`, one quiet dot-separated line under the header;
  hides itself when the area is quiet.
- **Capture bar** — `CaptureBar`: a textarea + "Capture" button. On submit it
  calls `api.albatrossIntents.createIntent({ rawText, source: 'chat', areaId })`,
  fires the best-effort `/api/albatross/plan` kick (same contract as the global
  launcher), and sets `pendingOpenIntentId` so `AppShell` switches to Plans with
  that intent selected. Cmd/Ctrl+Enter submits. Not a chatbot.
- **Needs you** — `NeedsYouSection`: plan-answers rows get an "Answer" button
  (opens the plan), suggested-context rows get a "Review" link to Settings;
  overdue tasks stay informational (already shown with their date in Tasks).
- **Plans** — `PlansSection`: plan-as-document rows (title, tone badge via
  `PlanToneBadge`, outcome/summary line, a hover next-move verb) that open the
  live `PlansSurface` at that intent through `pendingOpenIntentId`.
- **Projects** — `ProjectsSection`: title, outcome, paused badge; a project born
  from a plan links back to its source intent ("Open plan"); a standalone
  project stays informational (no fabricated link).
- **Places** — `PlacesSection`: compact 2-up cards, each an external Google Maps
  search link (`target="_blank" rel="noreferrer"`).
- **Deeper-surface affordances** — mail rows open the reader (existing); Events
  and Tasks section headers carry a quiet `ViewLink` to the Calendar / Board
  surfaces (`setPrimaryView`); Context links to `/settings?tab=areas`.
- Empty-state gate switched from `noLinks` to `briefEmpty` (nothing linked **and**
  no plans/projects/places/facts), so an area with only plans still renders its
  sections. `PlansSurface` is untouched and still routed.

### `components/shell/AppShell.tsx` & `lib/client-state.ts`

`pendingOpenIntentId` (transient, never persisted) bridges the brief's capture /
open-plan actions to `AppShell`, which reuses the existing `handleIntentCaptured`
(switch to Plans + select). No new routing surface invented.

## Design-system fidelity

Dense editorial rows with the same `SectionHeader` rule as the inbox; no
marketing hero, no nested cards (place cards are the one intentional bordered
tile, matching the existing area chooser tiles — not stacked inside another
card), no decorative blobs/orbs. Tones reuse the app's `--color-accent` /
`--color-warning` / `--color-success` / `--color-danger` variables and the
per-area `categoricalColor` dot — no one-note purple/blue palette.

## Tests

`tests/albatross-area-home.test.ts` (41 pass): existing suites plus new coverage
for `areaPulse` (order / plural / quiet), `planStatusMeta` + `planActionLabel`
(needs-answers precedence, all statuses, fallback), `intentDisplayTitle`
(title/raw/truncate/never-empty), `mapsSearchUrl` (encoding), `areaNeedsYouRows`
(ranking, filters, latest-plan needs-answers, cap, null inputs), and
`extractAreaPlaces` (structured-first, mapQuery fallback, address-only options,
dedup, blank-skip, cap). `bun test` green; `tsc --noEmit` clean.

## Limitations & follow-ups

- No GitHub issue backs this work (documented above).
- Standalone projects (no `sourceIntentId`) have no dedicated page yet, so they
  render informational-only rather than linking to a broken destination. When a
  project detail surface exists, wire it here.
- The `ViewLink` targets switch the primary view (Calendar / Board) but do not
  yet pre-scope those surfaces to the area's board — honest but coarse. A future
  increment could deep-link to the area board once board selection is in client
  state.
- The capture bar kicks planning fire-and-forget; plan errors surface on the
  Plans surface after handoff, not inline in the brief (matches the global
  launcher's contract).
- Places rendering was verified via unit tests on the extraction logic and a
  clean typecheck; it was not exercised against a live seeded area in this
  session.
