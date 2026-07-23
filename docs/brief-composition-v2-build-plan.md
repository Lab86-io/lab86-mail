# Brief Document v2 — Build Plan

Date: 2026-07-23
Spec: `docs/brief-composition-v2-spec.md` (contract, vocabulary, degrade rules)
Constraint: iOS feature-parity work is in flight on `staging` → PR to `main`. This plan is
sequenced so v2 work never blocks or destabilizes that merge.

## Git strategy (works around the parity merge)

- All v2 work happens on a feature branch `feature/brief-document-v2`, cut from `staging`
  HEAD (committed state — not the uncommitted parity working tree). Staging will merge to
  main; branching from it means the iOS phase sees the parity code it must build on.
- Phases 1–2 are **purely additive** (new files only: contract lib, new endpoints, tests) —
  zero conflict surface with the parity diff (which touches
  `app/api/albatross/*`, `app/api/compose/draft`, `app/api/mobile/{devices,preferences}`,
  `app/api/tasks/autofill` + tests). These can start immediately.
- Phase 3 edits `lib/mail/agent-report.ts` + Convex — files the parity work does not touch;
  safe in parallel, rebase before PR.
- Phases 5+ (iOS renderer) **wait until the parity PR lands in main**, then rebase. The iOS
  tree is exactly where parity churn lives; don't fork it twice.
- Everything ships behind a flag (`BRIEF_DOCUMENT_V2`, env-scoped, staging first) and behind
  the `artifactSource: 'document-v2'` discriminator, so merging v2 branches into staging/main
  at any point is deploy-safe even mid-build. Dual-write keeps legacy HTML rendering until
  Phase 7.
- Normal ship path throughout: feature branch → staging → PR to main → Railway CI.

## Phase 0 — Sign-off + vocabulary research  *(no code)*

- Jakob signs off spec §2–§6 (node vocabulary is the load-bearing part).
- Design research pass validating/extending the vocabulary: Mobbin (editorial front pages,
  dashboards, media shelves), Apple HIG / Liquid Glass (what iOS leaves should be), current
  shadcn idiom. Albatross-facing conclusions are Codex's per `CLAUDE.md`; run this as a
  Codex-reviewed pass. Output: vocabulary deltas folded into the spec, then vocabulary frozen
  for v1 (additions later ride the forward-compat rules, not spec churn).
- Decide the two open spec questions that gate code: query catalog v1 scope; `prompt` leaf on
  Daily Brief at v1 or Area-only.

## Phase 1 — Contract library  *(additive; start immediately)*

New files only:
- `lib/shared/brief-document.ts` — v2 Zod recursive schema (regions → tree → nodes), repair
  pass (v1 `repairBriefComposition` philosophy), mechanical lint (depth ≤ 4, ≤ 48 nodes/region,
  ≤ 12 regions, ≤ 1 hero, ≤ 2 canvas, homogeneous grids, count/length clamps), fallback-card
  substitution for irreparable subtrees.
- `lib/shared/brief-document-fixtures.ts` — canonical fixture documents: a rich brief, a quiet
  brief, a degenerate brief (unknown kinds/variants/actions, future version) used by *both*
  renderers' degrade tests.
- `tests/brief-document.test.ts` — schema/repair/lint/degrade coverage.

Acceptance: `bun test` green; fixtures exercise every degrade rule in spec §8.

## Phase 2 — Hydration + action plumbing  *(additive; parallel with Phase 1 review)*

- `app/api/mobile/briefs/resolve/route.ts` — batch ref resolution (`thread|task|event|card` →
  current state) for iOS.
- `app/api/mobile/briefs/query/route.ts` — enumerated query catalog (v1 set from spec §4).
- Web needs no new endpoints (existing TanStack queries cover refs/queries); add a small
  `lib/brief/hydration.ts` mapping ref kinds/queries → existing query keys.
- Action tier map (`lib/shared/brief-actions.ts`): reversible-with-undo vs review-gated, shared
  by both clients.
- Route tests per repo policy (`tests/mobile-briefs-resolve-route.test.ts`,
  `tests/mobile-briefs-query-route.test.ts`). Mind the existing HTTP-contract test patterns.

Acceptance: route tests green; contract documented in the spec's §8.

## Phase 3 — Generation behind flag  *(daily brief first; staging-only)*

- `lib/mail/agent-report.ts`: new `composeDocumentV2()` path — `place_region` /
  `finalize_brief` tool loop (AI SDK v6 tool calls), per-region validate→repair→lint→persist,
  progressive `artifactStatus`. Gated by `BRIEF_DOCUMENT_V2`.
- Dual-write: v2 document + existing deterministic HTML fallback
  (`buildNativeDailyReportArtifact`) so stale clients render.
- Convex: add `document` field + save/read mutations; set `artifactSource: 'document-v2'`.
  ⚠ Convex codegen pushes to prod — coordinate the schema push deliberately (additive optional
  field only; no breaking change).
- Prompt work: vocabulary reference + composition rules replace the HTML_ARTIFACT_BRIEF body
  for the flagged path. Keep the editorial-designer voice; swap the output contract.
- Cost/latency sanity check on staging: tool-loop tokens vs current HTML generation (expected
  cheaper; verify), stays within cron `maxDuration = 300`.

Acceptance: staging cron produces valid v2 documents for the test account; malformed-region
telemetry visible in logs; legacy HTML still renders everywhere.

## Phase 4 — Web renderer (Daily Brief)  *(flagged)*

- `components/report/brief-canvas/` — `BriefCanvas.tsx` + one component per node kind; reuse
  `components/tool-ui/` for chart/stats/timeline; shadcn primitives + theme tokens for
  surfaces/emphasis/tone; canvas leaf via existing custom_widget sandbox runtime.
- `DailyReport.tsx`: render `BriefCanvas` when `artifactSource === 'document-v2'` (+ flag);
  iframe path untouched otherwise. Progressive region reveal off `artifactStatus`.
- Actions: direct mutations + optimistic updates + undo toast (reversible tier); inline review
  popover (consequential tier). Delete no bridge code yet.
- Degrade tests against Phase 1 fixtures; visual verification via the headless screenshot loop
  (localhost, playwright chromium, client-render polling).

Acceptance: flagged staging account gets a fully native, interactive, live-hydrating Daily
Brief; unknown-kind fixture renders fallback cards; theme switching restyles the brief live.

## Phase 5 — iOS renderer  *(starts after parity PR lands in main; rebase first)*

- `apps/ios/Lab86Mail/Features/Today/BriefDocument/` — `BriefDocumentView` walking the tree;
  node views styled by `Surface.swift` (`surface: 'glass'` → materials); extends the
  `AssistantToolCards` payload-parsing pattern.
- Hydration client in `MobileAPI` for the Phase 2 endpoints; `query_list` refresh on appear.
- Actions via `environment.tools.invoke` + `CommandOutbox`; undo affordance for reversible
  tier; `ArtifactActionReviewSheet` retained for the consequential tier only.
- `prompt` leaf as native TextField (restores capture/answer on iOS).
- Canvas leaf: contained WKWebView reusing `BriefArtifactDocument` sanitize + nonce CSP,
  height variants.
- Degrade behavior against the same fixtures (unknown kind/variant/action/version).
- Verify on the authenticated simulator loop; ship via CI/TestFlight as usual.

Acceptance: Daily Brief on device is native end-to-end (no full-page WKWebView), task toggles
round-trip through the outbox, old-binary degrade verified by rendering a future-version fixture.

## Phase 6 — Area briefs + plan dossiers

- Generation: `lib/albatross/area-living-brief.ts` moves to the same tool loop (keep
  `areaArtifactRevision` short-circuit); `albatrossWorkV2.saveAreaBrief` gains the document
  field.
- Renderers (`AreaHome.tsx`, `AreaDetailView.swift`, plan/work surfaces) are **Albatross UI —
  Codex-owned**. Hand off: spec + contract lib + fixtures + the Daily Brief renderers as
  reference implementations. Claude scope ends at generation + contract here.

## Phase 7 — Flip + cleanup

- Flag default on in prod; new briefs stop generating HTML (drop dual-write); HTML read path
  kept for historical briefs.
- Retire web bridge runtimes (`withReportArtifactRuntime`, `area-artifact-runtime` for
  full-page use) once no surface reads them; iOS full-page webview path deleted; sanitizer
  machinery survives only inside the canvas leaf.
- Memory/docs updates; watch the first weeks: does output feel composed vs assembled →
  vocabulary expressiveness backlog (canvas-promotion telemetry from Phase 3 logs).

## Risks / gotchas ledger

- **Convex codegen pushes to prod** — schema additions must be optional/additive; push deliberately.
- **CI**: coverage gate + `api.d.ts` drift have bitten before; run the full local gate before PRs.
- **Cron budget**: tool loop must stay under 300s across all users in a fan-out tick.
- **OpenRouter/token caps**: keep generation under the gateway's default output caps (streamed
  tool loop, small per-call payloads — inherently safer than 900-line HTML one-shots).
- **App Review lag**: never ship a web-side contract change that violates §8 degrade rules;
  fixtures + tests are the enforcement.
- **Staging parity merge**: rebase feature branch after it lands; iOS phase gated on it.

## Sequencing summary

```
now ──────────────► parity PR lands ─────────────────────►
Phase 0 (sign-off + research)
Phase 1 (contract lib)        ─ additive, safe now
Phase 2 (endpoints)           ─ additive, safe now
Phase 3 (generation, flagged) ─ safe now, rebase before PR
Phase 4 (web renderer)        ─ safe now, flagged
                               Phase 5 (iOS renderer)
                               Phase 6 (areas/plans, Codex)
                               Phase 7 (flip + cleanup)
```
