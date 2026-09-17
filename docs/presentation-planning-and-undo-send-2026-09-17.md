# Presentation production and dependable Undo Send

## Product changes

Presentation requests now have a dedicated `presentation_plan` tool. The chat workflow gathers real evidence first, invokes a planner with high reasoning effort, then executes the resulting retrieval, spreadsheet calculation and visual construction tasks. Every slide has a takeaway, purpose, source IDs, representation choice, data requirements, layout and tool steps. Unknown evidence IDs are repaired internally; missing evidence is returned as work to retrieve, never invented values. The agent gets up to 40 steps after invoking the planner, versus 20 for ordinary chat.

The builder reviews every page, including pages whose copy already fits. It accepts reasonable draft paragraphs beyond the old 320-character boundary, retries missing reviews and targeted copy repairs within bounded deadlines, and preserves original text/citations in speaker notes. If editorial review is unavailable, local fitting still runs and the tool reports the incomplete editorial review in its notes. Charts remain native editable charts. The new table composition uses editable text cells and rules; its values survive PowerPoint export and restyling. Existing palettes, typography and density are preserved. Source collection, workbook arithmetic and final saved-slide verification are explicit agent tool tasks; the planner does not pretend those operations have already run.

Send now creates an immediate optimistic corner toast before preparation/upload completes. The web route holds content in a durable, user-scoped Convex outbox for the selected window and makes no provider send request before that deadline. Undo and dispatch compete through one atomic claim. Early Undo creates a cancellation tombstone so a late upload cannot revive the send. Retries cannot duplicate provider handoff. Provider ambiguity remains uncertain; only confirmed success triggers the existing SENT stamp and fireworks. The explicit instant setting and future scheduled sends retain their separate paths.

The internal callback uses the existing secret-gated `/api/cron` route family, which bypasses interactive Clerk/basic authentication. Staging's Convex callback origin was verified as `https://mail-staging.lab86.io`. Payloads live in Convex file storage for attachments beyond document size limits, are deleted on cancellation/success, and retained at most seven days for recorded failures. User deletion removes outbox records and their payloads.

## Research and visual review

Mobbin tools are unavailable in this session. The existing composer and presentation renderer were inspected directly, and the actual UI was exercised with Playwright. No registry component replacement was necessary for these corrections.

- [Nylas scheduled-send documentation](https://developer.nylas.com/docs/v3/email/scheduled-send/) and [cancellation reference](https://developer.nylas.com/docs/reference/api/messages/delete-a-scheduled-message/) explain why provider scheduling/cancellation is unsuitable for a short app undo window. The previous route could silently fall back to an immediate send after a `send_at` rejection.
- [Convex scheduled functions](https://docs.convex.dev/scheduling/scheduled-functions) informed the durable hold and atomic claim. Callback retries are explicit; a potentially completed provider send is never retried.
- [Datawrapper's table design guidance](https://www.datawrapper.de/blog/guide-what-to-consider-when-creating-tables) informed the choice of tables for exact values, restrained rules, fewer columns, and consistent numeric alignment. Tables reuse the existing deck design system.
- [Official OpenAI model guidance](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.5) and the installed SDK types confirm high reasoning effort for the dedicated planner. Ordinary chat keeps its existing effort setting and model selection.

Local visual evidence: `/tmp/albatross-send-PIkaSw` contains desktop/mobile toast and stamp screenshots. `/tmp/presentation-review-evidence/slide-1.png` is the rendered editable table fixture, reviewed at 1920×1080. All fixture data is synthetic; browser verification sends no real email.

## Validation

Focused tests cover outbox deadline enforcement, early cancellation, duplicate enqueue/claim, owner isolation, crash uncertainty and late confirmation; compose route preference handling and hold failure; per-page editorial coverage and partial retries; source preservation; fabricated numeric repairs; evidence planning and missing-source remediation; table rendering/restyling/editable PowerPoint export; and provider reasoning options.

Playwright checks the actual new-message and reply Send buttons before a delayed response, Undo before acknowledgment, every draft mode and attachment restoration, blocked storage, offline/cancel failures, reload, stacked sends, 5-minute countdowns, narrow light/dark layouts, reduced motion, confirmation-only celebration, and animation cleanup.

Local validation: 4,024 tests passed, 1 optional artwork render skipped, 0 failures; production build and typecheck passed; repository lint passed with existing nonblocking diagnostics. The outbox route tests were rerun after adding held-send and dispatch audit entries. Remote staging validation covers the release health and internal callback authentication. A live mailbox send and a paid end-to-end AI presentation run are not part of the synthetic regression checks.
