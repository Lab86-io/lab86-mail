# Brief Composition v2 — Native Interactive Briefs (DRAFT for discussion)

Date: 2026-07-23
Status: draft — decisions below agreed in conversation, contract details open for review
Owners: contract/generation/hydration + Daily Brief surfaces (Claude scope); Albatross-facing
renderers (AreaHome, plans/work dossiers) are Codex-owned per repo `CLAUDE.md`.

## 1. What changes and why

Today all three brief artifacts (Daily Brief, Area living brief, Work/plan dossier) are
LLM-authored self-contained HTML documents rendered in sandboxed iframes (web) and a sanitized
nonce-CSP WKWebView (iOS). Interactivity is limited to `data-action` click bridges; iOS strips
`<form>`/`<input>` so Area capture/answer forms are dead there; content is a frozen snapshot
that decays all day; theming requires token injection into finished HTML.

v2 replaces the HTML document with a **typed composition tree** (JSON). Each client renders the
tree with its own real components — shadcn/React on web, SwiftUI (Surface.swift / Liquid Glass
materials) on iOS. The model keeps full editorial authority: it decides what data appears, what
leads, how dense each region is, how items group. It never emits style values or markup (except
the `canvas` escape hatch, §5.6).

### Decisions locked (2026-07-23)

1. **Hybrid freshness.** Editorial voice (structure, framing, prose) is frozen at generation
   time. Data-bearing leaves hydrate live: they reference entities/queries, and clients render
   current state. Completing a task in the brief mutates the same state every other surface reads.
2. **Layout tree, not a section template.** The vocabulary is a recursive tree of layout nodes
   + semantic content leaves. Compositional decisions (hierarchy, pacing, grouping, selection)
   belong to the model; pixel realization belongs to the per-platform components and the user's
   theme. No style values in the contract, ever.
3. **Domain-blind leaves.** Leaves are shapes of information (stat, chart, collection, entity
   list), not features. New domains (health, finances, watchlists) are new data + tools, not new
   renderer code. Design test for every leaf: could it render a domain that didn't exist when we
   wrote it?
4. **`canvas` escape hatch for whimsy.** Model-authored HTML remains available as a sandboxed
   *leaf inside the native tree* (existing custom_widget machinery, contained WKWebView on iOS).
   Cost gradient is deliberate: native nodes are interactive/live/themed; canvas is frozen
   ornament. Repeated canvas use for the same shape is the promotion signal for a new native node.
5. **Generation = one tool call per region** (`place_region`), payload is a depth-capped tree.
   Regions stream into the UI in call order; each validates independently; a bad subtree degrades
   to a fallback card instead of killing the document.
6. **No blanket confirm().** Reversible actions (toggle/dismiss/resolve/archive) act immediately
   with inline undo. Consequential actions (rsvp, create_event, anything outbound/creative) keep
   an explicit review step (iOS `ArtifactActionReviewSheet` shrinks to this set).
7. **Forward compatibility is a hard rule.** Unknown node type / variant / action must degrade
   gracefully on old iOS binaries (see §8). Web deploys instantly; iOS ships through App Review.

## 2. Document shape

Extends the existing `BriefComposition` v1 (`lib/shared/brief-composition.ts`); v2 lives beside
it (new `lib/shared/brief-document.ts`), same repair/clamp philosophy (`parseBriefComposition`,
`DISPLAY_LIMITS`-style bounds).

```ts
BriefDocumentV2 {
  version: 2
  title: string                 // notification + fallback surface
  summary: string               // plain-text digest; old clients + push + a11y
  generatedAt: number
  regions: BriefRegion[]        // order = place_region call order; max 12
}

BriefRegion {
  id: string                    // stable within doc; enables region-level regeneration
  intent?: string               // model's note-to-self ("today's one big thing") — telemetry/debug
  summary: string               // REQUIRED plain-text degrade for the whole region
  tree: BriefNode               // depth ≤ 4, ≤ 48 nodes per region
}

BriefNode = LayoutNode | ContentLeaf
```

Common node fields: `kind`, optional `emphasis: 'primary'|'standard'|'muted'`,
optional `tone: 'neutral'|'positive'|'warning'|'urgent'` (theme resolves meaning; never colors).

## 3. Layout nodes

| kind | children | knobs | notes |
|---|---|---|---|
| `stack` | 1–24 | `density: 'airy'\|'standard'\|'dense'` | vertical flow; default container |
| `grid` | 2–12 | `columns: 2\|3` (advisory; clients may reflow) | children should be homogeneous (lint) |
| `split` | exactly 2 | `ratio: 'balanced'\|'lead'` | side-by-side on wide, stacks on narrow |
| `hero` | 1–3 | `surface: 'plain'\|'elevated'\|'glass'` | max one per document (lint) |
| `group` | 1–12 + `title`, `kicker?` | `surface`, `collapsible?` | titled card/section wrapper |

`surface` maps to Surface.swift elevation / Liquid Glass materials on iOS and shadcn card
treatments on web. The theme owns what each value looks like.

## 4. Content leaves — data-bearing (live-hydrating)

Every data leaf carries: frozen editorial framing (the model's words) + refs the client hydrates.
If a ref no longer resolves, render the framing struck-through/muted with a "gone" affordance —
never a hole, never a crash.

- **`entity_list`** — the workhorse. `items: [{ ref: BriefSourceRef (existing schema),
  framing: { reason?, lane?, prep? }, actions: BriefAction[] }]`, `variant:
  'rows'|'cards'|'compact'`. Covers needs_you, task_digest, week_ahead, tool_digest from v1.
  Client hydrates subject/title/time/status/avatar from the ref; completed/archived items
  reflect reality, not the 7am snapshot.
- **`query_list`** — self-updating set. `query` from an enumerated catalog (v1 catalog:
  `tasks_due_today`, `tasks_overdue`, `events_today`, `events_next_7d`, `unresolved_tracked_threads`,
  `area_open_work(areaId)`), plus `limit`, `variant`, `emptyText` (model-authored). Use when the
  model wants "whatever is true when you look" instead of pinned picks.
- **`stat`** — `label`, `value` (frozen) OR `queryValue` (from same catalog), `delta?`, `unit?`.
- **`chart`** — unify with `show_chart` payload (`lib/tools/display.ts`) + v1 chart block:
  variant `bar|stacked_bar|donut|line`, data points, sourceRefs required.
- **`timeline`** / **`checklist`** — carry over from v1 blocks, checklist items may bind
  `toggle_task` refs so checking is real.
- **`collection`** — generic media-forward items: `{ image?, title, meta?, badge?, ref?,
  actions? }`, `variant: 'shelf'|'grid'|'list'`. This is the watchlist/reading-list/product
  shape; deliberately domain-blind.

## 5. Content leaves — editorial (frozen)

- **`text`** — `role: 'lede'|'kicker'|'body'|'aside'|'caption'`, inline-markdown subset
  (bold/italic/links only). The editorial voice lives here.
- **`actions`** — standalone action group: `BriefAction[]` (existing schema + styles).
- **`prompt`** — replaces Area capture/answer forms: `variant: 'capture'|'question'`,
  `placeholder`, `questionId?`; renders a real TextField on iOS (fixes forms-stripped bug) and
  posts `capture_intent`/`answer_question`.
- **`divider`** — `variant: 'line'|'space'|'flourish'`.
- **`canvas`** (§5.6) — escape hatch: `{ id, title, html ≤ 20k, fallbackText REQUIRED,
  allowedActions ⊆ action vocabulary, height: 'compact'|'medium'|'tall' }`. Web: sandboxed
  iframe (existing custom_widget runtime). iOS: contained WKWebView reusing
  `BriefArtifactDocument` sanitize + nonce CSP. Non-interactive beyond allowlisted clicks.
  Prompt rule: data and actions belong in native nodes; canvas is for vibe no node expresses.

## 6. Actions & confirmation

Action vocabulary is unchanged from v1 `BRIEF_ACTION_TYPES` + area actions
(`open_work`, `discuss_area`, `capture_intent`, `answer_question`). Backend handlers untouched.

- **Immediate + undo:** toggle_task, dismiss_task, resolve_thread, dismiss_thread,
  archive_thread. Web: direct mutation via existing endpoints + TanStack optimistic update +
  undo toast. iOS: `environment.tools.invoke(...)` + undo affordance.
- **Review-gated:** rsvp_event, create_task, create_event, draft_reply (and any future
  outbound/spend action). Web gets a proper inline review popover (replacing top-window
  `confirm()`); iOS keeps `ArtifactActionReviewSheet` for exactly this set.
- Unknown action name on an old client: hide the control (never render a dead button).

## 7. Generation

- `place_region({ region: BriefRegion })` tool, callable ≤ 12 times, in
  `lib/mail/agent-report.ts` and `lib/albatross/area-living-brief.ts`. Optional final
  `finalize_brief({ title, summary })`.
- Each call: Zod parse → repair pass (v1 `repairBriefComposition` style) → mechanical lint:
  depth ≤ 4, ≤ 48 nodes/region, ≤ 1 hero/doc, grid children homogeneous, canvas ≤ 2/doc,
  clamp counts/lengths (DISPLAY_LIMITS style). Lint is mechanical, not a taste gate.
- Irreparable subtree → replace with fallback card rendering `region.summary`; log for telemetry.
- Regions persist as they arrive; `artifactStatus: composing → ready` becomes visibly
  progressive. Revision short-circuit (`areaArtifactRevision` sha) carries over.
- Prompt keeps the editorial-designer voice but the constraint set becomes: vocabulary reference,
  hydration semantics (pinned vs query), action tiers, canvas cost-gradient rule, "must read
  correctly under any user theme" (no color/style assumptions).

## 8. Storage, transport, compatibility

- Convex: store `document` (v2 JSON) alongside existing fields; `artifactSource` discriminates
  (`'document-v2'`). Old briefs keep the HTML read path forever; no migration.
- During transition, generation dual-writes: v2 document + legacy HTML fallback (deterministic
  `buildNativeDailyReportArtifact`) so stale clients render something.
- **Client degrade rules (hard requirements, tested):**
  - unknown node kind with children → render children in a `stack`;
  - unknown leaf kind → render nearest `summary`/`fallbackText` as a plain card;
  - unknown enum value → documented default (variant/emphasis/tone/surface);
  - unknown action → hide control; unknown query → render `emptyText`;
  - document version > client max → whole-document fallback card from `title` + `summary`.
- Hydration API: web uses existing queries; iOS gets batch resolve endpoints under
  `/api/mobile/*` for refs (`thread|task|event|card`) and the query catalog. Mobile HTTP
  contract changes get route tests per repo policy.

## 9. Rollout

| Phase | Work | Notes |
|---|---|---|
| 0 | This spec agreed; vocabulary validated by design research (Mobbin editorial/dashboard patterns, Liquid Glass HIG, current shadcn idiom) | research may add/rename leaves before code |
| 1 | `lib/shared/brief-document.ts` (schema + repair + lint) + tests | pure contract, no UI |
| 2 | Generation behind flag: `place_region` loop in Daily Brief cron, dual-write | staging-only first |
| 3 | Web `BriefCanvas` renderer for Daily Brief behind flag; retire iframe bridge on that surface | Daily Brief first: flagship, and not Albatross-owned |
| 4 | iOS SwiftUI renderer (extends `AssistantToolCards` pattern + Surface.swift); canvas leaf via contained `BriefArtifactDocument` webview | ship via CI/TestFlight as usual |
| 5 | Area brief + plan dossier move to v2 | renderers are Codex-owned (Albatross UI) |
| 6 | Stop generating HTML for new briefs; keep read path for history | delete web bridge runtimes when unused |

## 10. Open questions

1. Query catalog v1 scope — the six listed enough? (Each needs a mobile endpoint.)
2. `prompt` leaf on Daily Brief too (quick capture from the morning brief), or Area-only at first?
3. Region-level refresh: allow the assistant to regenerate a single region on demand
   ("update my day") — supported by region ids, but is it v1 scope?
4. Does `collection` need a `progress` field (habit streaks / watch progress) at v1, or wait
   for the canvas-promotion signal?
5. Undo semantics for `archive_thread` on iOS offline queue (`CommandOutbox`) — undo = enqueue
   inverse command, or cancel pending?

## 11. 2026-09-03 budget

Decided by Jakob on 2026-09-03 (refinement round, Wave C). The Daily Brief and the Area brief
now compose from a fixed budget. The v2 node tree stays. The tool-loop composer, the HTML
artifact model call, and the month pass are gone.

### Daily Brief

- Budget by plan tier: `BRIEF_ITEM_BUDGET = { free: 5, pro: 7, team: 9 }`
  (`lib/mail/brief-score.ts`). The tier comes from the stored entitlement
  (`lib/mail/brief-plan.ts`); unknown plans default to `pro`. `admin` maps to `team`.
- Three lanes replace the seven: `answer` (max 3), `today`, `know` (max 3). Calendar events
  for today sit in the `today` lane and do not count against the budget (max 4 events).
- Deterministic score before any model call (`scoreBriefCandidate`): direct-to-you +3,
  sender the user has written to before +3, thread the user took part in +2, due date inside
  48 hours +3, `needs_reply` in the Smart Category primary or secondary +2, list or bulk or
  automated sender -4. Items under score 1 are noise. `selectBriefItems` fills the budget
  top-K by score, then `receivedAt` descending, then key, one entry per thread.
- `CANDIDATE_LIMIT` is 120. The enrich cap is 12 (`LAB86_MAIL_REPORT_MAX_ENRICH` still
  lowers it). Enrichment runs in score order.
- One prose model call (`lib/mail/brief-prose.ts`, feature `daily_brief_prose`) writes the
  lede (max 4 sentences), one line per item (max 20 words, may be empty), and the week ahead
  (max 4 sentences with weekday names and dates from the user's timezone and the forward
  7-day calendar). The prompt forbids the word "AI", emoji, and ALL-CAPS words; the parser
  removes any sentence that names "AI". Without a model the letter is deterministic.
- The document (`lib/mail/brief-budget-document.ts`) is:

  | region id | tree | when |
  |---|---|---|
  | `lede` | `hero { text role:lede }` | always |
  | `answer` | `entity_list title:"Answer" variant:rows` | items |
  | `today` | `entity_list title:"Today" variant:rows` (event refs, then thread refs) | items or events today |
  | `know` | `entity_list title:"Know" variant:rows` | items |
  | `week-ahead` | `text role:body` | prose present |
  | `areas` | `entity_list title:"Areas" variant:compact` (area refs, max 3) | areas |

  Each thread item: `ref {kind:"thread", id, account, label: subject}`,
  `framing {lane, reason?: the line, sender?: display name}`, `actions: [open_thread]`.
  Each event item: `ref {kind:"event", id, account, label: title}`,
  `framing {lane:"today", reason: time range and location}`, `actions: [open_event]`.
  Each area item: `ref {kind:"area", id, label: name}`, `framing {reason?: one line}`,
  `actions: [open_area]`. `framing.sender` is new and optional.
- Stored edition (`dailyReports`): new `sections.answer`, `sections.today`, `sections.know`
  (items carry `score`, `budgetLane`, `sender`, `line?`), `stats.noise`, `stats.selected`,
  `prose { lede, weekAhead, model }`, and `tier`. `newPeople`, `fyi`, and `bulkTail` are
  written empty; `noiseSummary` is no longer written. Old editions still read and render.

### Area brief

- The area brief is a pulse `{ lastChange, nextMove, openQuestion, prose }` (`prose` max 3
  sentences) from one fast model call (feature `albatross_area_pulse`). It is stored on
  `albatrossAreaBriefs.pulse` with `pulseUpdatedAt` (`convex/albatrossAreaPulse.ts`).
- The document is deterministic: `lede` (hero), `pulse` (stack of body lines), `ask`
  (`prompt` variant `question` with the pending question id, else `capture`), and
  `open-work` (`query_list area_open_work`). A small HTML fallback is kept in
  `artifactHtml` and `artifactSource` stays `document-v2`, so `area_home` readers work
  without change.
- The Daily Brief embeds at most 3 areas, 1 line each, from the pulse (`nextMove`, then
  `openQuestion`, then `lastChange`) or the report's area context.

### Model calls per brief

Before (week pass, v2 flag on): up to 3 classify + 15 enrich + 1 narrative + up to 14
tool-loop steps, about 33. With the flag off the legacy path added a month pass (8 classify +
30 enrich + 1 narrative + 1 HTML) on top of 1 HTML call: about 60. After: up to 3 classify +
up to 12 enrich + 1 prose call, at most 16. Area brief: 1 call, down from up to 14 tool-loop steps.
