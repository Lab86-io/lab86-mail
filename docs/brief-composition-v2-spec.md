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
