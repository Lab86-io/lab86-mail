# Narrative connections: chat, Albatross planning, and reliable writing

Scope: shared backend/web orchestration only. No Apple-platform/mobile-v1 edits, new provider connections, consent changes, external sends, or production promotion.

## Fixes and behavior

- Chat retrieves a bounded packet using attached, owned Work/Area anchors and up to three recent user text messages. Short follow-ups can retain their subject; assistant claims and binary attachments are not search queries. The request's cancellation reaches retrieval and generation. User statements still enter memory as reports, not verified events.
- Albatross planning retrieves relevant Work plus Area history alongside existing context. Prior decisions get normal plan citation handles, including observations discovered during research; summaries are not independent evidence. The saved plan and its companion document can reference these sources. Existing answers take precedence over old memory.
- Work creation, updates, saved plans, and answered questions schedule consent-checked narrative capture immediately. The narrative distinguishes an observed saved-plan record from a proposed action, and a user's answer from verified completion. Cleared/changed answers revoke stale current observations before background capture finishes. Recorded evidence-backed interpretations also queue refresh.
- Each refresh publishes one chapter, prioritizing the current brief. Historical chapters remain indexed and durably pending for later coalesced/hourly runs, within the existing 24-run/day limit. The result reports publication and deferred counts; a later chapter cannot fail an already finished brief in the same run.
- The host reads and supplies evidence before generation. Sparse packets go directly to structured writing; richer packets get optional research with a 45-second limit. Writing has a 65-second attempt budget and at most one retry for provider/empty-output failures, within the 210-second run cap. Citation validation and publication-time revision/consent checks remain mandatory. Research prose is not added as evidence.

## Evidence and verification

The earlier live failures were a skipped forced start-tool call and a later-chapter timeout after brief publication. These changes remove that dependency and split the work into smaller durable units; they do not relax provenance checks or alter the strict smoke assertions.

Reviewed [official OpenAI tool-choice guidance](https://developers.openai.com/api/docs/guides/function-calling#tool-choice) and [AI SDK tool-calling/cancellation behavior](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling). The implementation retains the configured GLM model and existing provider gateway. SDK guidance informed explicit cancellation propagation and separate generation budgets; no model upgrade or new credential is required.

Focused regressions cover sparse/rich research paths, skipped/stuck research, stuck/empty writing attempts, forged citations, revoked sources, multiple Work/Area anchors, contextual follow-ups, source-ref mapping, question/plan observation semantics, owned capture scheduling and immediate answer revocation. Full suite/coverage, deployment identity and live synthetic results are recorded in the PR. No UI layout changed; existing UI research remains in `docs/narrative-tools-research.md`.
