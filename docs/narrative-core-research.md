# Shared narrative core — implementation and research

Scope: web and shared backend; no native Apple or mobile-v1 contract changes. Staging pilot, explicitly opted-in sources, initial 30-day backfill. Narrative is a navigable index of evidence, not an authoritative biography.

## Research

The Mobbin skill was read. Its search_screens/search_flows tools are not available in this session, so no Mobbin results are claimed. Intended web queries: memory settings with individual source checkboxes and delete controls; dated personal history with linked source disclosures; search suggestions with context and timestamps.

Browser-reviewed [Mem Collections](https://help.mem.ai/features/collections): readable single content column, topical collections in addition to chronology, explicit organization controls. Adopt topical threads without replacing the day-based history.

[Granola spaces and folders](https://docs.granola.ai/help-center/sharing/folders/spaces-and-folders) and [source-linked meeting queries](https://www.granola.ai/blog/query-meeting-notes-across-folders): bounded source scopes and drill-through citations. Adopt per-connection opt-in and visible evidence; do not assume permission for another surface follows an existing integration toggle.

[LongMemEval](https://arxiv.org/abs/2410.10813) motivates tests for temporal retrieval, revised facts, cross-session continuity, and abstention. Summaries are fallible derived records; repetition must not upgrade trust.

## Implementation decisions

- Observations retain occurrence time separately from ingestion time. Source updates replace current state while preserving prior versions as history.
- Day/week/month chapters and topical threads link to underlying observations. Compaction does not discard unresolved Work or source provenance.
- Agents receive a navigation protocol and bounded retrieval tools, not a whole-life prompt. Brief research is read-only.
- Corrections and deletion invalidate derived records. Exclusions prevent forgotten observations being reimported. Source disable removes derived copies, not original provider data.
- Server-side user ownership and consent checks apply to every read/write, including source expansion. Provider failures and limited coverage are visible, never interpreted as inactivity.
- Run leases, resumable cursors, bounded batches, cancellation, model-call/output caps, and daily run limits keep automation bounded.

## Verification

- Full regression: 3,243 passing tests after writer hardening; focused runtime/agent checks also cover progress-to-final composition and future source changes after corrections. CI checks are attached to the staging PRs.
- Typecheck, whole-repository lint, and a production build passed locally; CI repeats them for the exact release commit.
- Live synthetic [GLM-5.3-Flash](https://docs.z.ai/guides/vlm/glm-5.3-flash) evaluation uses a real read-only source tool, revised intentions, a merged PR with unknown deployment state, and a scheduled meeting without attendance evidence. Free-form JSON proved unreliable; structured output fixed the tested case. The checked response honored the correction and preserved both uncertainties. Run `bun scripts/eval-narrative.ts` with an OpenRouter key to repeat (billable, synthetic data only).
- The full deployed-backend smoke exposed issues not covered by the standalone model test: a progress placeholder was returned as a final answer, and a model-selected entry id failed to resolve. Each research pass now begins with a zero-argument, host-bound evidence tool; publication requires that it ran. Short/header-only answers, loading placeholders, and explicit unsupported global inactivity claims are rejected. Tool read errors are recoverable without exposing provider/server internals. This is a fallible model with bounded evidence, not a claim of perfect factual recall.
- Each chapter has a bounded research phase (up to four model steps), followed by one explicitly tool-disabled final writing step. Research acknowledgments are not published. This preserves the same five-model-step ceiling per chapter. Corrections also retain the original source version: replay cannot overwrite the correction, while genuine subsequent source changes can still move the story forward.
- Sparse chapters (at most three observations) start with one evidence-reading step, then write; richer chapters can investigate further. When the first chapter uses most of the run's time budget, the next chapter stays queued for a later run instead of starting work that is unlikely to finish.
- The final writer cites host-generated short codes, constrained by its output schema and mapped back to exact observation ids before publication. Live testing caught the model mistyping opaque database ids; unknown codes are rejected, and only evidence actually exposed to research receives a code.
- For legacy corrections or captured turns with no source-version baseline, the first subsequent source sync establishes a baseline without overwriting the correction. Later changed versions advance the account normally. This conservatively preserves the correction during an ambiguous first sync rather than freezing it permanently or treating a replay as new evidence.
- Browser verification on staging covered source consent off by default, keyboard checkbox selection, the populated two-column history/evidence view (synthetic browser-only responses), keyboard correction and dependent-account invalidation, forget confirmation/cancel, floating search, category arrows, and Enter-based page navigation. Browser fixtures were removed afterward; no real account was enabled.
- `scripts/smoke-narrative-staging.ts` is explicitly restricted to the development environment and staging Convex URL. It creates only an isolated synthetic narrative, verifies model generation, deployed search, provenance and correction revocation, then erases that test memory. It never enables real-user source consent.
- Final live smoke passed with GLM-written current and monthly accounts, canonical citation restoration, deployed full-text search, source expansion, correction invalidation, and immediate erase revocation. This runs the local writer against the deployed staging backend and real model, with a synthetic-only runtime adapter; it does not claim a real user's provider archive was exercised.
- Staging exposes the feature to the owner's verified account only. Sources remain unselected until explicit opt-in. No production or native/mobile-v1 changes.

## Deliberate limits

- Retrieval is indexed lexical search plus time/topic filtering and ranked ongoing threads, not vector search. Tools and prompts have hard context bounds.
- Initial backfill is the last 30 days, plus older current Work/Area state. Resumable bounded batches continue on later runs; this is not a claim to have read entire provider archives.
- Multiple-resolution chapters compact what agents retrieve. Original observation evidence is retained until forgotten or its source is removed; this is not lossy deletion of old evidence. Old chapters remain searchable, and unpolished chapters have a separate queue so recency-ranked search cannot starve them.
- The brief reserves evidence slots for intentions and ongoing Work alongside changes from other sources. It reads live narrative permissions rather than embedding another narrative copy into immutable reports.
- Corrections invalidate only dependent chapters using source versions; source removal and erase revoke access immediately and physically clean up in bounded background batches. Existing chat answers and saved Work artifacts are not retroactively rewritten.
- Only content already indexed by the existing mail/calendar/file/MCP integrations is available. Source expansion reports sync timestamps and partial coverage. Missing meeting transcripts or disconnected connectors remain missing, not evidence of inactivity.
- GLM is routed through OpenRouter; current-model selection remains subject to conservative verified pricing and the existing account AI controls. No silent expensive fallback. At most two passes, five model steps per pass, twelve tool reads per pass, 4k output tokens per step, 24 runs/day, and a $0.50 conservative reservation limit per run.
