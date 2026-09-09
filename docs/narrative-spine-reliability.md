# Narrative reliability and long-running context

## Scope

Fix the real-account writer failure, age stored history into navigable overviews,
and improve task-specific cross-service retrieval. No source consent, OAuth
credentials, native UI, or external provider records are changed by this increment.

## Real-account diagnosis

The previous real-account run sent roughly 43k input tokens through research;
the writer then timed out and its smaller retry returned no structured output.
OpenRouter's live metadata lists GLM-5.3-Flash reasoning as mandatory. Its reasoning
shares the output allowance, so reducing a retry from 4,000 to 2,000 total tokens
can prevent JSON prose from appearing. The corrected writer uses a bounded,
trimmed source packet, two research steps, shorter requested prose, an 80-second
attempt deadline, and the same 4,000-token ceiling for either attempt. The overall
210-second run and paid-run reservation remain bounded. Only a validated, cited
account is published; a fallback is never labeled model-written.

The pre-deployment real-account acceptance produced a cited, 1,707-character
model-written brief in about 95 seconds. This is evidence of recovery, not a claim
that a provider can never fail. Repeat against the promoted staging release.

References: [OpenRouter reasoning tokens](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens),
[OpenAI structured-output failure handling](https://developers.openai.com/api/docs/guides/structured-outputs).

## Compaction contract

- Recent 14 days: detailed daily chapters; 14–90 days: weekly; older: monthly.
- A persisted 80-observation cursor sweeps **all stored history**, beyond the
  recent 800-record compilation window, and restarts to handle aging/late changes.
- Overviews merge earlier evidence windows, retain up to 60 representative source
  links, preserve corrections/open commitments and source/chronological diversity,
  and use stable priority sampling to converge on repeated passes.
- Monthly prose is capped at 1,400 characters; weekly at 1,800; briefs at 2,200.
- Originals and already-created finer chapters are retained. Navigation exposes
  the covered date range for deeper search. This is a representative overview,
  **not a lossless substitute for all evidence or recursive summary corroboration**.
- Each scheduled write rechecks consent, ownership, source versions and revision.
  Corrections, withdrawal and forgetting immediately revoke stale summaries.
- Pausing with unchanged source selection retains observations/cursors; erasure
  and explicit source removal still remove the associated stored memory.

## Retrieval contract

The existing classification tier rewrites only the short user query into at most
four alternate terms. A 3.5-second deadline, 800-token cap, no retries, and ordinary
gateway billing bound that lane; failure leaves lexical lookup available. No
historical content is sent for expansion. Up to four specific project, repository,
mail-thread, document or email-address relationships are followed one hop from
relevant visible observations. A topic index/backfill finds older links outside
the recent window. Shared topics locate context; they do not establish causation.

The final packet still re-reads evidence, rejects revision changes, and is bounded
to 12 records / the consumer's character and time limits. Outgoing drafts bypass
semantic/relationship expansion and require explicit individual evidence selection.
This is hybrid semantic query expansion plus exact relationships, not vector search.

Topic/text expressions respect [Convex's token limits](https://docs.convex.dev/search/text-search).
Compaction meters new and existing evidence plus underlying source reads, stopping
at a conservative byte/read allowance. An oversized existing account is retained
if its prior evidence cannot be fully revalidated within that allowance; raw
evidence remains available. This protects the transaction rather than pretending
to have processed every large source document.

## Review disposition

GitHub CodeRabbit review 5151620099 and a separate local CodeRabbit pass completed.
Valid findings addressed include consistent writer limits, preserved brief
intentions, explicit source-excerpt truncation, normalized source-set comparison,
bounded topic expressions, configure-triggered manual refresh, source read budgets,
and deterministic/isolated acceptance tests. Two optional optimizations were
deferred: per-query relevance memoization and removal of the cached client's
configuration guard. The reported duplicate module-level loop tail is not present
in the actual file; typechecking and executable tests confirm the function parses.
Request a follow-up review of the fixes before staging promotion.

## Acceptance

Focused tests cover boundaries, local periods, 901-record resumable sweeps,
stable repeat passes, evidence retention, correction/forget/disable behavior,
paraphrase retrieval, cross-service expansion, privacy and gateway budgets.
Use `scripts/check-real-narrative-staging.ts` only for the existing opted-in pilot.
Use `scripts/smoke-narrative-spine-staging.ts` for synthetic historical and live-model
acceptance; its synthetic connections carry no provider credentials and are removed
from use afterward. Run existing brief, meeting/draft and global-search regressions
as well as the full suite, lint, typecheck and deployment CI before main promotion.
