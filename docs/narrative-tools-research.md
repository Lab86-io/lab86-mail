# Narrative context in tools — staging rollout

Scope: shared backend and web. Native Apple clients and mobile-v1 contracts are unchanged. Promote through staging, then open a PR to main for two completed CodeRabbit reviews; do not merge main.

## UI research

The required Mobbin skill was read, but this session has no Mobbin screen/flow tools. No Mobbin screenshots are claimed. Intended web searches: editable email draft with selectable context and accept/cancel controls; calendar event details with collapsed meeting preparation and source citations; insufficient-context and retry states.

Browser-reviewed [Superhuman Write with AI](https://help.superhuman.com/hc/en-us/articles/46005557122957-Write-with-AI): separate drafting from acceptance, preserve editable copy, keep adjacent work visible. Apply as an inline, keyboard-operable draft assistant, never an automatic send.

Browser-reviewed [Granola pre-meeting briefs](https://docs.granola.ai/help-center/taking-notes/pre-meeting-briefs): short, expandable preparation, open threads, visible citations and source opt-in. Apply within existing event details rather than a new dashboard. Sparse evidence must be stated, not padded with invented history.

Granola is a source into Albatross, not a consumer of Albatross memory. The existing per-user OAuth/MCP connector is reused. Its [separate REST API](https://docs.granola.ai/introduction) also offers personal keys on Business/Enterprise, but changing transports is not required for this rollout. Narrative retrieval remains transport-independent and prioritizes relevant Granola meeting evidence without admitting unrelated meetings.

## Shared contract

- Bounded, model-free task context; source consent, current corrections, evidence links, coverage and freshness are preserved.
- Summaries locate supporting observations; they are not independent proof.
- Outgoing drafts use only explicitly selected observations and the source versions the user actually reviewed. Corrections require re-selection; sources are checked again after generation. Private unrelated history is not silently put into a recipient's draft.
- Verified application operations and Work progress feed the narrative; generated prose never counts as proof of action.
- Background refreshes coalesce. An interaction does not wait for the narrative-writing model.
- Real-user sources stay opt-in. Synthetic tests never send email, edit provider calendars, or enable a real account's memory.

## Implemented surfaces

- Inline composer: **Draft with context**, unselected evidence checkboxes, source inspector links, editable generated preview, explicit **Use draft**, cancel and stale-message invalidation. No automatic send or overwrite.
- Calendar event details: on-demand **Before you meet**, up to three source-backed points and suggested questions. Owned synced event selectors are resolved server-side. Relevant Granola meeting notes receive a retrieval boost; participant metadata connects differently titled meetings. Provider failure falls back to exact excerpts.
- `narrative_task_context` joins the existing authenticated tool API. Chat, Work planning and Area pulses share the same bounded retrieval through `narrativePrompt`. This is not a newly exposed anonymous MCP server or API-key issuance service.
- Applied operation receipts and Work step ledger changes enter memory asynchronously, respecting source consent. Undo changes revoke outdated current receipts. A recorded step remains a report; an applied tool action is not proof of the whole Work outcome.
- Durable refresh coalesces bursts for 30 seconds, observes a five-minute cooldown and active writer leases, and retains the existing daily writer budget. Hourly ingestion recovers newly recorded operations. Disabling/erasing invalidates queued refresh tokens.

## Verification

- `bun run typecheck`, `bun run lint`, `bun run build`: passed.
- `bun run test:coverage`: 3,272 tests passed; no failures. Every changed narrative library file meets or exceeds the staging baseline. Shared context retrieval: 100% line coverage; meeting prep: 88.24%.
- Real components were rendered with production CSS in a synthetic-only Chromium harness at 1280px and 390px. Enter/Space selection, explicit draft acceptance, preserved original body, linked meeting sources and zero horizontal overflow passed. Screenshots inspected in both sizes.
- Reproduce the browser harness with `bun run build` then `bun scripts/preview-narrative-tools.mjs`; it binds loopback and blocks all real provider requests.
- Authenticated staging browser access verified through its existing Basic gate. No real user's memory consent was changed.

Known scope: source quality still depends on the existing Granola sync and selected source coverage. Indexed meeting notes are not guaranteed complete transcripts. Generated prep can fall back when its model is unavailable. A separate outbound API-key/MCP product remains a distinct integration decision; no new Granola credential is required here.

## Review hardening

The first full main review is [CodeRabbit review 5149707339](https://github.com/Lab86-io/lab86-mail/pull/230#pullrequestreview-5149707339), covering `ed9c2eb`. Its web/shared-backend findings are addressed in the follow-up staging increment:

- Compaction groups at most 960 candidate observations without recursively checking them all in one transaction. Four small buckets are written immediately; the remaining bounded buckets run as durable, revision-checked continuations. Each bucket checks at most 60 candidate observations and 60 existing sources. Stale jobs cannot restore corrected or revoked context.
- Recent pre-rollout action receipts have a separate creation-time history cursor; original receipts are never rewritten. Incremental update ingestion still catches undo changes.
- One draft deadline covers auth, retrieval, generation and the final source recheck. Cancelled context lookups cannot start a paid generation. Ordinary message/CC/BCC edits invalidate evidence and preview without discarding instructions; identity changes still reset the assistant.
- Meeting preparation ignores sync bookkeeping when checking freshness, while agenda/participant/time changes and cancellations still invalidate it.
- Correction editors start from the latest source; turning memory off clears unsaved selections; HTML proxy failures show an actionable message; the brief polls only during an active writer.
- Search feedback/recovery controls sit outside the listbox. Successful mail interpretation is a notice, not an error. Clearing a distant calendar target restores the normal query window. Uncontrolled event dialogs remain functional when an observer callback is supplied.
- Area context retrieval has an eight-second sub-budget within the existing one-minute pulse deadline. Text-only chat queries are bounded; independent evidence reads overlap; disabled planners omit narrative tools; malformed read IDs return unavailable instead of crashing a turn. Structured narrative generation consumes the SDK's validated output.
- The actual Turbopack build emits CSS in `.next/static/chunks`; the preview harness retains that verified path and also supports `.next/static/css` with a clear missing-build error. Both synthetic smoke scripts preserve primary and cleanup failures.

Native findings for mounted iOS mail-search delivery and historical macOS toolbar dates remain explicitly assigned to the Apple-platform owner (Claude), per `AGENTS.md`. No native files were edited in this increment. Main remains unmerged. The legacy PR template's Claude-only web checkboxes are superseded by the current ownership instructions, which permit direct Codex web implementation; no Claude or Mobbin run is falsely claimed.

Signed-in staging verification of the initial integration passed: editable draft generation without accepting/sending, on-demand source-linked calendar prep, authenticated context reads, and the exact deployed release health. Granola is not connected on the checked account yet; the user must connect it and opt it into narrative sources. Existing connector code is ready, not an assertion that the user's Granola account is already linked.

## Second review follow-up

[Second full CodeRabbit review 5149871818](https://github.com/Lab86-io/lab86-mail/pull/230#pullrequestreview-5149871818) completed on the original `ed9c2eb` head while #231 was being deployed. This is a second completed review, not an approval of the later fixes. A subsequent full-review request failed at the reviewer service; a retry was requested. Main stays open pending final disposition and Apple-owner review.

- Forgotten source-key opt-outs survive full memory erasure and re-enablement; they retain no source text. The confirmation explains this explicitly. Historical versions use an indexed current-version lookup. Forget revokes all versions and their derived chapters immediately, while deletion proceeds in durable batches of 20. Regression coverage includes 241 versions and preservation of an unrelated source.
- Hourly refresh dispatch rotates through enabled users using a least-recently-dispatched index; coverage exercises 204 enabled users across three batches rather than repeatedly selecting the first 100.
- Optional chat capture has a three-second ceiling. Planning context has an eight-second sub-budget inside the existing model deadline. Search-body aborts remain cancellations, and meeting quota is checked before body parsing.
- Structured and streaming generation both pass the narrative model override to runtime selection, not to the provider SDK. The queued refresh route test executes its callback and checks the authenticated owner.

Review triage: the Granola boost deliberately checks normalized provider text because source IDs are `mcp:<opaque connection ID>`, not `mcp:granola`; switching to the suggested source-string match would break real connections. Existing relevance filtering still applies. Broad test-renderer replacement, unused-index cleanup and selector/formatting nits are deferred rather than expanded into a new migration. No native Apple edits were made.

The reviewer retry subsequently completed as [review 5149941757](https://github.com/Lab86-io/lab86-mail/pull/230#pullrequestreview-5149941757) on `051de71`. Its three new findings are addressed by preserving draft instructions/open state during To-field edits (while clearing stale evidence and previews), bounding the agent's own narrative lookup to eight seconds, and forwarding meeting cancellation into both initial and post-generation context reads. Thread changes still reset the assistant. Final-code approval remains distinct from these completed reviews.
