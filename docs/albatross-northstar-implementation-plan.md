# Albatross north-star implementation plan

Date: 2026-08-01
Source: `docs/albatross-northstar-ux-audit.md`
Owner: Claude implements the UI directly (`AGENTS.md`).

## Correction to the audit

Two findings about the Daily Report were artifacts of the dev environment, not
design defects. The dev Convex deployment does not run the brief crons, so the
brief I saw was 24 days old and described an empty day. Production is healthier.

Dropped: "the brief is stale", "the brief writes about a day with no
obligations".
Kept, because they do not depend on data freshness: the inverted hierarchy, the
seven-day weather chart, the invented section names, the three type systems.
Demoted to a small task: a brief still has no freshness indicator, which matters
when a cron does fail.

---

## How to judge every PR in this plan

One question, from the north star:

> Does this screen remove responsibility from the user, or reorganize it and
> hand it back?

Three hard gates on every PR:

1. No upper-case micro-labels.
2. No machine confidence, score, or internal state name in user copy.
3. Whatever needs the user is the largest thing on the screen.

---

## Round 0 — the vocabulary contract

One short PR, no UI. It stops the rounds after it from arguing about words.

**Deliverable:** `docs/albatross-vocabulary.md` — one table, one word per idea,
plus the forbidden list.

| Idea | The word | Never |
|---|---|---|
| The object | Albatross | intent, work, idea, task, item |
| The list of them | Albatrosses | Plans, Work, Intents |
| The daily surface | Today | Daily Report, Daily Brief |
| Capture | Get this off my mind | New Idea, New Work, Capture |
| A step the system will do | Next move | action, step |
| Proof | Proof | evidence, artifact |
| Put it down on purpose | Release | archive, dismiss, delete |
| A missed block | Passed | overdue, late, missed, failed |
| Areas | Areas | life buckets, contexts |
| The system | Albatross | AI, assistant, the model, the classifier |

**Test:** `tests/albatross-vocabulary.test.ts` — a lint-style test that greps
`components/` and `app/` for the forbidden words in JSX text and string literals,
with an explicit allowlist for identifiers. This test is the enforcement
mechanism for round 1 and every round after.

Cost: half a day. Do it first; it makes rounds 1–3 mechanical.

---

## Round 1 — identity and navigation

The largest visible change, and almost entirely deletion and renaming. No new
features. Target: five PRs on one branch, promoted as one batch.

### PR 1.1 — Delete the unreachable code

| File | Action |
|---|---|
| `components/albatross/AreasLive.tsx` | delete — no importer |
| `AlbatrossSurfaces.tsx` → `IntentsSurface`, `AreasSurface` | delete — unroutable since the shell stopped mounting them |
| `AlbatrossSurfaces.tsx` → `AlbatrossSurface` wrapper | reduce to `UnassignedSurface` only, then fold that into round 2 |
| `components/shell/AIBar.tsx` → `AIBarTrigger` | delete the button, keep `AssistantChat` |
| `lib/shared/types.ts` | remove `'intents'` from the enum |

Roughly 6800 lines out. `AlbatrossSurfaces.tsx` drops from 4500 lines to the
shared vocabulary helpers plus the unassigned queue.

**Tests:** update `tests/albatross-*.test.ts` that import the deleted exports.
Add `tests/albatross-routing.test.ts` asserting the enum no longer accepts
`intents` and that a persisted `intents` maps forward.

**Acceptance:** `bun test`, `tsc --noEmit`, `biome check .` clean. No route
change visible to a user yet.

### PR 1.2 — Kill the flag

`LAB86_ENABLE_ALBATROSS` (`lib/hosted/controls.ts:27`) goes. The product cannot
have its centre behind an environment variable that silently falls back to a
magazine.

- `app/page.tsx`, `app/client-page.tsx`, `AppShell.tsx`, `Rail.tsx`,
  `lib/shared/types.ts` — drop the `albatrossEnabled` parameter throughout.
- `normalizePrimaryView(view)` loses its second argument.

**Tests:** `tests/albatross-routing.test.ts` — every Albatross view resolves for
every user.

**Risk:** production may be running with the flag off. Check the Railway
production variable before merging; if it is off, this PR is the moment the
product turns on for real users. That is a Tier 5 decision, not a Tier 4 one.

### PR 1.3 — The route enum

```
CORE_PRIMARY_VIEWS = ['today', 'albatrosses', 'mail', 'calendar', 'files', 'areas']
LEGACY_VIEW_MAP    = { daily_report: 'today', intents: 'albatrosses',
                       unassigned: 'albatrosses', tasks: 'today' }
```

- `lib/shared/types.ts` — new enum, plus `migratePersistedView()`.
- `persistedPrimaryViewFromStorage()` runs the map, so the `lab86-mail-ui`
  localStorage value from an existing session never lands on a blank pane.
- `AppShell.tsx:351` — `PrimarySurface` switch updated. `today` renders
  `DailyReport` unchanged for now; round 3 replaces the contents.
- `albatrosses` renders a placeholder list in this PR, filled in round 2.

**Do not rename any agent tool.** The iOS client binds to
`get_latest_daily_report`, `list_daily_reports`, `dismiss_daily_report_task`,
`dismiss_daily_report_thread` (`apps/ios/.../ProductStore.swift:359`,
`DailyBriefView.swift:363`). Tool renames are a separate, later PR with a
matching iOS change.

**Tests:** `tests/albatross-routing.test.ts` — table-driven, every legacy value
in, every new value out, including the persisted-storage path.

### PR 1.4 — The rail

Rewrite `components/shell/Rail.tsx` (1142 lines, expect ~600 after).

Remove:
- the `Lab86 Mail` title (line 402) → `Albatross` with `by Lab86` beneath
- the `Compose` button (line 418) → moves into the Mail surface header
- the ten `MAILBOXES` rows (lines 84–95) → a filter row inside Mail
- the four `SMART_CATEGORIES` rows (lines 144–169) → same
- the smart-label settings gear inside the group label → Settings
- the `ALBATROSS` group label over the area rows

Add:
- `Get this off my mind` as the primary accent control, first in the rail
- `Today`, `Albatrosses`, `Mail`, `Calendar`, `Files` as the surface list
- an `Areas` group, sentence case, with the live area rows and `+ New area`
- `Search`, `Activity`, `Settings` in the footer
- a word badge on Albatrosses — `2 need you`, never a number

Delete `railAreaBadge` usage that renders the pending-fact count
(`lib/albatross/area-home.ts`), and the `{n} verified` badge at
`AreaHome.tsx:466`.

**Tests:** extend `tests/albatross-intent-rail.test.ts` — the rail exposes the
six surfaces, the capture control, and no numeric badge. Add a test that the
badge helper returns words.

**Acceptance:** a screenshot of the rail, in the PR, next to the audit's
"before" shot.

### PR 1.5 — The style and copy sweep

- Remove all **54** `uppercase tracking-*` micro-labels across 19 files. Worst:
  `DailyReport.tsx` (11), `Rail.tsx` (7), `WorkDetail.tsx` (7),
  `BriefNodeView.tsx` (5).
- Remove every user-visible confidence value:
  `Inbox.tsx:1429` (percentage badge), `AreaOnboarding.tsx:639` (word),
  `AlbatrossSurfaces.tsx:212` (`confidenceLabel`). Low confidence asks a
  question or shows nothing.
- Replace `classifier` in the Areas empty state, `{n} artifacts`
  (`AlbatrossSurfaces.tsx:542`), and `Candidate`/`Verified`/`Rejected` as
  user-facing words.
- Settings: `Your mailboxes, your models, your rules` → new subtitle; the `AI`
  tab is renamed; `Back to inbox` → `Back to Albatross`.
- Mail gets a real empty state. Today it shows eight skeleton rows forever with
  no account connected.
- The capture launcher label stops animating and reads `Get this off my mind`
  (`IntentCapture.tsx`, `GooeyMorphText` usage).
- The floating truncated question card is deleted; the notification popover keeps
  the questions until round 3 gives them a page.

**Tests:** the round-0 vocabulary test now passes on the whole tree. Add a style
test asserting zero `uppercase tracking` occurrences in `components/`.

**Acceptance:** screenshots of Mail, Areas, Settings and the capture sheet.

### Round 1 exit criteria

- The rail says Albatross and names the product's own objects.
- No route renders a different surface than the one the user asked for.
- The three hard gates pass, enforced by tests.
- Nothing new was built.

Ship: Tier 4 (staging, two CodeRabbit rounds), then Tier 5 with
`Release-Bump: minor`.

---

## Round 2 — the Albatross

The point of this round: **the gold-allocation questions become a page.** Right
now the product carries a real, live, well-reasoned albatross and no screen
shows it.

### PR 2.1 — The four primitives

New, in `components/albatross/primitives/`:

| Component | Contract |
|---|---|
| `StateChip` | one of needs-you · in progress · waiting · maintaining · someday · paused · done · released. Shape and weight carry the state; colour does not. |
| `OutcomeHeader` | the three-fact ribbon — Outcome · Next move · Last proof — on one line, serif outcome, sans facts |
| `NextMove` | one sentence, one control, an effort estimate, and who it needs |
| `AlbatrossRow` | list row: title, state chip, next move, area, whether it needs the user |

Reference for the ribbon: the Squarespace project header — three facts, no chart
(<https://mobbin.com/screens/41d2a034-ddc0-4eba-8907-306131b3c388>).

**Tests:** `tests/albatross-primitives.test.ts` — every state renders a distinct
chip, the header degrades when there is no proof yet, the row never renders a
count.

### PR 2.2 — Promote `PlansSurface`

`components/albatross/PlansSurface.tsx` (1999 lines) is the best UI in the
repository and has no front door. Mount it.

- New view `albatross/:id`, rendered by the shell, not by the picture-in-picture
  window.
- Merge `WorkDetail.tsx` (472 lines) into it. `WorkDetail` currently owns the
  work-v2 header, the questions card and the artifact frame; `PlansSurface` owns
  capture, plan, approvals and apply. One surface, one question component.
- Keep `QuestionsSection`/`QuestionRow`; delete `WorkQuestionCard`.
- Header becomes `OutcomeHeader`.
- Section order, per the north-star anatomy: Outcome · Now · Plan · Guided work ·
  Progress · Context · Outputs · Questions · Activity · Conversation. Sections
  with no content do not render — a two-step albatross must not show a
  seven-section shell.
- `AlbatrossCompanion` picture-in-picture moves behind a setting.

**Tests:** `tests/albatross-detail.test.ts` — a quick outcome renders four
sections, a project renders nine, a practice renders the phase instead of a
completion bar.

### PR 2.3 — The Albatrosses list

New surface, grouped by state, not by area:

`Needs you` · `In progress` · `Waiting` · `Maintaining` · `Someday` · `Paused` ·
`Completed` · `Released`

Filters: area, shape, person, account, age, waiting party. The old `unassigned`
review queue becomes a filter here and the route disappears.

**Tests:** `tests/albatross-list.test.ts` — grouping, the derived `needs you`
state, and the empty state for each group.

### PR 2.4 — Areas, corrected

- `AreaHome.tsx:862` gains the tabs the north star names: Brief · Albatrosses ·
  Mail · Calendar · Files · People · History. The Albatrosses tab matters most.
- `+ New area` works from the rail and from the Areas header.
- Facts stop being a queue. A fact appears inside the Albatross that uses it,
  with the source, and nowhere else.

### PR 2.5 — The `needsYou` selector

One definition, server side, in `convex/albatrossWorkV2.ts` or a new
`convex/albatrossState.ts`:

```
needsYou = open blocking question
         | pending approval
         | required login
         | required physical action
         | sensitive choice
         | automation failure awaiting a decision
```

Consumed by Today, the rail badge, the list, the notification centre, and the
iOS client. Today these surfaces already disagree — the main pane said `0
active` while three questions waited in a popover.

**Tests:** `tests/albatross-needs-you.test.ts` — one fixture, six consumers, one
answer.

### Round 2 exit criteria

- Opening the gold-allocation albatross from the rail shows its outcome, plan,
  three questions and sources on one page.
- Answering a question there updates the plan in place.
- No surface disagrees with another about what needs the user.

---

## Round 3 — Today

Rebuild the contents of `DailyReport.tsx` (2443 lines). Keep the brief engine and
the tool contract; replace the layout.

### PR 3.1 — The layout

Two columns, not a dashboard. Left: what needs the user. Right: the schedule.
Reference: the Rox home screen
(<https://mobbin.com/screens/62b4d10c-498e-49eb-bf78-3b944290f407>).

Sections, in order:

1. **Needs you** — small number of items, largest type on the page
2. **Fixed schedule** — solid styling
3. **Flexible intentions** — dashed styling, named by their Albatross
4. **Important mail** — only mail that moves an open outcome
5. **Waiting, not forgotten**
6. **Ongoing practices** — at most two
7. **Evening check-in**

Header: date, one human sentence, and the capacity control.

### PR 3.2 — Demote the decoration

- The seven-day weather chart becomes one line in the header.
- `Quiet bulletin` and `Main tension` are replaced by the section names above.
- The masthead painting stays but stops being the first 400px of the page. It
  belongs below the fold or at reduced height. The reading experience was the
  best thing about the brief; keep it, subordinate it.
- Add a freshness line: when the brief was written, and a control to rewrite it.
  Cheap, and it would have made the dev-environment confusion obvious.

### PR 3.3 — Capacity

`CapacityControl`: low · normal · high. Manual only. Calendar density may
suggest; health data may not. The suggestion copy is tentative, never
diagnostic.

### PR 3.4 — Make Today the default

`app/client-page.tsx` `initialView` becomes `today`. Existing persisted views
still win, through the round-1 migration.

**Tests:** `tests/albatross-today.test.ts` — section order, the empty day, a day
with only fixed events, and a day where nothing needs the user.

### Round 3 exit criteria

- The largest thing on Today is whatever needs the user.
- A day with no obligations says so in one line and stops.

---

## Round 4 — forgiveness

This round is where the emotional promise becomes behavior. It needs a schema
change first.

### PR 4.1 — Schema

Additive, in `convex/schema.ts`:

1. `released` in the work-state union, with `releaseReason`, `releaseProposedBy`
   (`user` | `system`), `reviewAt`.
2. `shape` on `albatrossIntents`: `quick` · `project` · `practice` · `decision` ·
   `monitor` · `recurring`. `albatrossRoutines` becomes the practice engine under
   the parent object, not a peer table.
3. `lapses` table: `stepId`, `plannedAt`, `whatHappened`, `reason`,
   `reasonSource` (`user` | `inferred`), `recovery`, `revisedPlanId`,
   `revisionHeld`.

Convex codegen pushes to prod — run it deliberately, per
`docs/hosted-release-runbook.md`.

### PR 4.2 — The lapse prompt

`LapsePrompt`, used by the calendar, Today and the detail page. A passed block is
never red and never says overdue. Reasons and recoveries exactly as the north
star lists them. `Shrink` proposes a smaller step in words.

### PR 4.3 — Release and review

- `ReleaseSheet` — reason, optional review date, optional note. Presented as a
  success, in the same visual family as completion.
- `ReviewBatch` — *These four have not moved in a while. Which still deserve
  space?* Batched, never one prompt per item.
- A staleness policy per shape, in `convex/crons.ts`. Not a flat 90 days: a small
  administrative task deserves review in two weeks; a paused practice after an
  injury must not ask repeatedly; a government application waits for its real
  processing time.

### PR 4.4 — Calendar, fixed against flexible

`CalendarSurface.tsx` (433 lines) draws one event style. Add the second. A missed
flexible block routes to the lapse prompt; a missed fixed event asks *Did this
happen?*

### PR 4.5 — Re-entry

*Welcome back. A lot may have changed.* Never a list of accumulated overdue work.

**Tests:** `tests/albatross-lapse.test.ts`, `tests/albatross-release.test.ts`,
`tests/albatross-staleness.test.ts` — including the case that a
judge-rejected or user-kept item does not reappear every cycle.

---

## Round 5 — proof

The centre of the product, and the reason it is not a copy of a chat assistant.

### PR 5.1 — The outcome contract

Per albatross: what done means, what evidence can establish it, what level of
proof suffices, whether Albatross may close it automatically, and what
contradictions reopen it. Editable by the user, proposed by the system.

### PR 5.2 — Claim-based evidence

`albatrossEvidence` rows gain `claim`, `confidence`, `limits`. `EvidenceCard`
renders the claim, the source, the observed facts and the limits.
**Confidence stays server side and never reaches the screen as a number** — it
selects the closure level and the wording, nothing else.

Closure levels shown to the user: `Action succeeded` → `Outcome likely` →
`Outcome confirmed`.

### PR 5.3 — Mail carries proof

Inside a thread: *This looks like proof for "Renew passport".* Controls:
`Use as proof` · `Not related`. This is the strongest single feature in the
product and the one nobody else can copy without a real mail client.

### PR 5.4 — The guided browser pane

`GuidedStepPane` — the step on the left, the site on the right. Modes:
`Guide me` · `Do it with me` · `Handle it`. Failure recovery as the north star
lists it. The shell already has the two-pane layout, so the cost is the pane
content, not the frame.

### PR 5.5 — Activity

One page: what happened, which account acted, what was accessed, what changed,
what was approved, what can be undone. iOS already has an `Activity` feature
folder; the web does not.

---

## Cross-cutting work

### iOS

The native client is **ahead of the web on naming**. Its feature folders are
already `Today`, `Work`, `Activity`, `Assistant`, `Mail`, `Calendar`, `Files`,
`Tasks`, `Settings`. So:

- Web converges on the iOS names, not the reverse.
- iOS renames `Work` → `Albatrosses` and gains the state list in round 2.
- iOS gets the lapse prompt and release sheet in round 4 — mobile is where a
  passed block is actually noticed.
- **Do not rename agent tools before round 5.** iOS binds to
  `get_latest_daily_report`, `list_daily_reports`, `dismiss_daily_report_task`,
  `dismiss_daily_report_thread`. A tool rename is one PR with both clients in it.

### Tests

219 test files today; `bun test`, `biome check .`, `tsc --noEmit`, `next build`
are the CI gates, and coverage is gated. Every PR above names its test. Three
tests are load-bearing for the whole plan:

- `tests/albatross-vocabulary.test.ts` — the forbidden-word lint
- `tests/albatross-routing.test.ts` — legacy views map forward
- `tests/albatross-needs-you.test.ts` — one definition, six consumers

### Delivery

Feature work on a **branch**, never a worktree. Refinements accumulate and are
promoted as a batch. Round 1 is one batch. Rounds 2 and 3 are one batch each.
Rounds 4 and 5 split at the schema boundary.

Per round: Tier 1 for server surfaces, Tier 2/3 for the native UI, Tier 4 for
staging plus two CodeRabbit rounds with findings applied between them, Tier 5 for
the merge with an explicit `Release-As:` or `Release-Bump:` trailer.

Every distributed build talks to production. Do not weaken `ci_post_clone.sh` or
`verify_built_configuration.sh` to make a build easier.

Note: staging iOS builds are currently blocked in `ci_post_clone` on a bad
`LAB86_API_BASE_URL`, which is an App Store Connect UI fix. Until that is fixed,
Tier 4 proves no Swift compile — verify native changes at Tier 2.

### Screenshots as acceptance

Each UI PR carries before/after screenshots taken the same way as the audit. The
driver is in the audit appendix. This is the only way the taste gates are
checkable by someone other than the author.

---

## Risks

| Risk | Handling |
|---|---|
| Removing the flag turns the product on for production users | Check the Railway production variable first; make it a deliberate Tier 5 decision |
| Deleting 6800 lines breaks an import nobody expected | PR 1.1 is typecheck-gated and lands alone |
| Persisted `lab86-mail-ui` strands an existing user on a dead view | `migratePersistedView()` plus a table-driven test, in the same PR as the enum |
| Renaming a tool breaks iOS silently | No tool renames before round 5; both clients in one PR |
| Round 4 schema push hits production Convex | Follow `docs/hosted-release-runbook.md`; codegen is not a local-only action |
| The plan is large enough to stall | Round 1 is deletion only. If nothing else ships, the four-apps problem is still gone. |

---

## Order

1. **Round 0** — vocabulary contract and its lint test. Half a day.
2. **Round 1** — identity and navigation. Deletion and renaming only.
3. **Round 2** — the Albatross object, the list, the detail, one `needsYou`.
4. **Round 3** — Today.
5. **Round 4** — forgiveness, after the schema PR.
6. **Round 5** — proof.

Rounds 1 to 3 change what the product looks like. Rounds 4 and 5 make it true.
