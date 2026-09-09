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
