# Jev promotion review

Promotion: [PR #280](https://github.com/Lab86-io/lab86-mail/pull/280), staging → main. Follow-up fixes: [PR #281](https://github.com/Lab86-io/lab86-mail/pull/281).

## Review evidence

The first full GitHub CodeRabbit review completed on `5a0084269a5c180a6f496efa917b678b752533f7`: [review 5273619678](https://github.com/Lab86-io/lab86-mail/pull/280#pullrequestreview-5273619678), run `0419f502-e80e-4b70-b202-fee87897e3ce`, with 11 actionable comments. All 11 were verified and addressed.

A supplemental authenticated CodeRabbit CLI review compared committed `a9fc3d5c` with `origin/main`. It completed with 51 findings, including repeated findings and overlap with the GitHub review. It is supplemental to the two requested sequential GitHub passes; a second full GitHub review is requested after these fixes reach the promotion head.

## Corrections

- Preserve corpus-owned message revisions; reuse account and Jev-policy reads inside classification/preparation operations. Stable metadata comparisons avoid unnecessary reclassification while preserving raw message line breaks for quote detection. Partial metadata updates retain hydrated recipients and search text.
- Bound connection discovery with indexed, persistent cursors. Content visits up to 50 records per connector table per tick. Jev visits 24 accounts per tick so its three-worker, 55-second fan-out remains inside the action budget. Later users are visited on following ticks.
- Bound reply scans to ten pages and persist the continuation against the current watch set. Reject stale checkpoints and keep unavailable evidence checks retryable. Retire Brief preparations after related work closes or disappears.
- Respect disabled personal API-key settings, bound/rate-limit settings bodies before JSON parsing, and use the shared timing-safe cron guard. Keep post-response content work attached to the Next.js lifecycle.
- Stop retrying permanently unavailable or malformed attachments, still retry transient failures, and download supported attachments whose size metadata is absent with the existing stream byte cap. Reject unsafe ZIP expansion metadata and malformed attachment identifiers. Accept deletion records that omit text.
- Omit HTML and return matching body excerpts in bounded mail search pages while retaining search text for local filters. Keep Jev cursors separate from date offsets, continue empty filtered pages, and show date headings only for chronological results.
- Retry every contributing Files query, show semantic loading/errors, open Brief backlog items in Mail, attach download links before clicking, clear successfully saved correction inputs and update duplicate matches in place. Give meaningful errors for malformed settings responses and share the settings fetcher.
- Preserve the six-item active-work budget and make optional attention bookkeeping unable to fail an already-saved Brief. Clarify historical reproduction scripts and remove obsolete scoring/enrichment logic.

## Suggestions not applied

- Replace four attention indexes with a single category: declined. Reply, action, waiting and change signals can overlap; a single scalar category cannot represent the current contract.
- Collapse stored mail body whitespace: declined. Line breaks distinguish quoted requests and are required for reader/evidence fidelity; search text remains normalized separately.
- Force a timezone or defer timestamp rendering: no current hydration defect was found. These timestamps are rendered from client-fetched queries without server-prefetched data; the existing display uses the user's local timezone.
- Cache Jev runtime availability: deferred. This does not make a provider inference request; it checks credential, entitlement and budget state. Keeping those checks fresh avoids stale key/billing availability after settings change.
- Extract the repeated active-reply-watch predicate: deferred as a behavior-preserving refactor. Existing lifecycle tests cover the identical guards.

The raw-row freshness suggestion was applied as clarification; normalization already removed stale assessments, so no prior stale-result exposure is claimed.

## Validation and product research

Local full regression/coverage run: **4,272 passed, one skipped, zero failures**, 36,293 assertions across 448 files. Typecheck and lint passed; lint retains the pre-existing warning and informational diagnostics. Subsequent Jev census-budget adjustment passed its focused regressions; CI validates the final pushed head.

Actual-component Chromium checks passed at 390, 768 and 1440 px. They cover correction reset and duplicate suppression, keyboard preference changes, persistence, reader evidence, draft editing/refresh/download/adoption/dismissal, and visible failures. The transport is synthetic; this is not a signed-in real-mailbox accuracy benchmark.

These are fixes to the researched surfaces, with the existing design system and density preserved. References and prior research/tooling limitations remain in [simplified Mail and Jev demo](jev-simpler-mail-and-live-demo.md) and [connected content and prepared work](connected-content-2026-09-21.md). No native Apple platform code changes.
