# Jev, the Daily Brief, and mail relevance — September 21, 2026

Historical research, captured before implementation. See [the shipped mail integration and validation notes](jev-implementation-2026-09-21.md) for the resulting changes.
**Recommendation: use Jev to maintain precise, reusable facts about mail; rebuild Brief eligibility and search ranking around those facts.** Replacing the existing classification model alone leaves several demonstrated failure paths intact. The largest opportunity is a reliable record of requests, commitments, changes and relationships that all Albatross surfaces share.

The Syracuse Athletics example occurred in the Daily Brief a few days ago, per the user's clarification. It is not a known search reproduction. This investigation did not retrieve that historical edition or its messages; the specific reason that email appeared remains unverified. Findings below distinguish inspected code, executed synthetic reproductions, live model measurements, and proposed product behavior. No application behavior or production data was changed.

Repository inspected: `e1e95b49` plus the pre-existing workspace state. Follow-up to [the broader Jev research](jev-2026-09-21.md). Browserbase browser sessions successfully inspected TypeSafe's limitations and reranking documentation and Gmail's importance documentation; conventional web retrieval supplemented them. Browserbase's separate Search/Fetch connectors had failed in the first pass. A browser session subsequently expired; that did not invalidate already retrieved pages.

**The Brief has selection defects that can admit a correctly recognized broadcast.**

| Finding | Evidence in this repository | Consequence |
| --- | --- | --- |
| Familiarity transfers across an entire domain | `daily-report.ts:300–320` stores recipients and domains from sent mail; `brief-score.ts:87–94` treats either as prior correspondence | Writing to one person at a university can give unrelated senders at that exact domain a relationship boost. This is a possible mechanism, not a verified fact about Syracuse's actual addresses. |
| Direct delivery is treated as personal relevance | `brief-score.ts` gives To-address membership +3, domain/address familiarity +3, and bulk mail −4; admission starts at 1 | A broadcast delivered directly to you from a familiar domain scores **2** and remains eligible. Most newsletters name their recipient in To. |
| Primary-tab mail can be assigned a reply obligation without a request | `smart-categories.ts:415` sets `secondary: ['needs_reply']` for human-looking Personal/Important mail; `isHumanLike` lets Personal bypass keyword checks unless hard-list/blocklist conditions apply | Both an athletics campaign with an unsubscribe footer and an explicit “No reply needed” message reproduced `needs_reply`. The campaign verdict simultaneously reported `isAutomated: true`. |
| The Brief independently infers duties from message direction | `daily-report.ts:667` treats latest inbound non-no-reply mail as reply owed; an outbound last message after three days plus earlier inbound mail can mean follow-up owed | A thank-you can become a reply task; a finished exchange can become a follow-up. Later human/automation protection gates narrow this, but they do not check whether a question remains open. |
| Incorrect protections are sticky | `daily-report.ts:906–940` instructs enrichment to promote only; `laneMax` enforces that restriction. Scores were already computed | A later, better reading cannot simply demote an incorrectly protected thread. Adding Jev at the prose/enrichment step will not repair selection. |
| Bulk status does not itself exclude Brief candidates | `daily-report.ts:1077` converts every non-hidden insight into a scored candidate | A correctly classified broadcast can enter the `know` section through the positive score above. |
| Three answer items can crowd out the fourth despite spare budget | `brief-score.ts` has answer cap 3, know cap 3, pro budget 7 | Four legitimate reply items plus one low-scoring broadcast produced three replies and the broadcast, with the fourth reply in overflow and only four of seven slots used. |
| Overflow is not carried into the budget Brief as an explicit backlog | `composeReport` uses answer/today/know, not `selection.overflow`; its noise count includes all unselected insights. `agent-report.ts:214` composes from those three selected lanes | Valuable overflow can be conflated with noise in the count. Older reply/tracked sections still exist in the report object, so this does not prove the item is inaccessible everywhere. |
| Important automation loses deadline extraction | `daily-report.ts:789` allows commitments only for non-automated human-or-personal mail | An automated rent, payment or booking notice can be excluded from deadline extraction even when it has a real consequence. “Automated” and “unimportant” are separate properties. |

Sources: [Brief scoring](../../lib/mail/brief-score.ts), [Brief generation](../../lib/mail/daily-report.ts), [Smart Categories](../../lib/mail/smart-categories.ts), [budget Brief composition](../../lib/mail/agent-report.ts). The [executable diagnostic](jev-2026-09-21/mail-diagnostics.ts) imports the actual current helpers and passed 11 assertions; [saved output](jev-2026-09-21/mail-diagnostics-results.json) records the classifications, score, cap behavior and search reordering. These are helper-level reproductions, not a production replay.

**Better classification also requires fixing where evidence is lost.** The initial weekly Brief bounds its candidate set at 90, using recent windows. The full pass includes unbounded-age human-oriented queries, but still bounds candidates at 120 and has per-query limits. Both prioritize the `humanKeys` group by recency before cutting it off. Membership comes from which retrieval query found the thread, not an assessed personal relationship. More than the cap can exist in that group; the code comment claiming real people are never truncated is therefore stronger than the implementation. An old unresolved obligation can be omitted before any model sees it.

The Brief calls `classifyThreadsBatched` afresh; it does not simply reuse the accepted corpus classification. That path normally invokes a model only below confidence 0.68 or for `review`, so the incorrect 0.82 Personal-category verdict can bypass semantic reconsideration. Body hydration exists, but the model line caps body text at 600 characters and snippet at 240; it is not a conversation-state model. The separate background sweep uses `force: true` and already attempts model classification for every latest message. Corpus precedence is user rules, then a current persisted model verdict, then deterministic rules. These differing paths can disagree about the same mail. [Batch classifier](../../lib/tools/ai.ts), [background sweep](../../lib/mail/llm-classify.ts), [corpus precedence](../../convex/smart.ts)

The sweep closes out a latest-message attempt even when no model verdict was returned. `storeLlmVerdicts` clears `llmPending` and records the attempted message ID; the deterministic fallback remains. This avoids retry loops but does not distinguish successful classification from an unavailable semantic result for automatic retry. A replacement needs explicit accepted, uncertain and unavailable states. Brief verdict maps also use bare thread IDs where account-scoped IDs would be safer. [Persistence](../../convex/mailCorpus.ts)

**Search independently throws relevance order away.**

The corpus full-text query takes an initial relevance window, filters dates, sorts by received time and clips again. Message-to-thread conversion sorts by date again. Global search asks for only eight threads per account, merges them, sorts by timestamp again and retains sixteen. Text queries use one retrieval window and provide no paging cursor. Structured predicates are partly applied after candidate retrieval; older scoped matches can be absent even when the corpus contains them.

The diagnostic supplied an older relevant conversation before a newer broadcast. Both the local thread conversion and global merge reversed that order. This is a demonstrated behavior of the helpers; it is not an evaluation of Convex's actual relevance scores. A model placed only after the final eight-per-account truncation cannot recover the omitted conversation. [Corpus search](../../convex/mailCorpus.ts), [local conversion and filtering](../../lib/mail/search/local.ts), [provider retrieval](../../lib/nylas/provider.ts), [global search](../../lib/search/global-search.ts)

The proposed order is: authorized and explicitly filtered retrieval, broader candidate union, message-to-thread grouping that preserves the strongest matching evidence, query-specific relevance, then final clipping. Preserve exact identifiers and requested sender/date constraints in code. Apply recency within similarly relevant results; keep an explicit most-recent order for users who want it. A query for an athletics advertisement should retrieve that advertisement. A query for a budget approval conversation should prioritize evidence of that conversation. Global importance is only a secondary signal.

This matches the direction of Gmail's documented relevant-search update, which adds interaction and frequent-contact signals to recency and lets users choose relevant or recent ordering. Its importance documentation also describes user-specific interaction signals and explicit corrections. Those are useful product precedents, not proof of the right weights for Albatross. Opens are weak feedback: reading a bad result can reflect checking why it appeared. [Gmail search update](https://blog.google/products-and-platforms/products/gmail/gmail-search-update-relevant-emails/), [Gmail importance signals](https://support.google.com/mail/answer/186543?hl=en)

TypeSafe's own reranking cookbook uses a shortlist before Jev. Its older `jev-1.12` example improves top-1 from 5% to 18% and top-10 from 38% to 62% over 40 legal queries. That supports testing the architecture, not assuming perfect mail search. The candidate set and the relevance question both matter. [Official reranking experiment](https://docs.typesafe.ai/cookbooks/rerank_typesafe)

**The new live probe supports speed and repeatability, while exposing classification boundaries.**

I froze 40 synthetic examples before calling the service: 28 mail-state cases and 12 query/candidate cases. Mail cases included campaigns versus owned-ticket changes, human thanks, answered questions, promises, CC responsibility, delegation, failed payment, sales urgency, missing attachments, quoted requests, injected instructions, a Spanish request, and a read but unanswered request. Each input was sent three times, sequentially, with no retries. Only synthetic data was sent through the existing OpenRouter credential.

| Measurement | Observed result |
| --- | ---: |
| Calls with valid typed results | 120 / 120 |
| Unique cases matching every expected label | 35 / 40 |
| Complete repeated responses matching expectations | 105 / 120 |
| Matching fields | 273 / 288 — 94.79% |
| Mail purpose, obligation, change fields separately | 81 / 84 each |
| Four-way search relevance labels | 30 / 36 |
| Cases whose discrete labels changed across three repeats | 0 / 40 |
| Cases with changed probabilities/confidence across repeats | 33 / 40 |
| Median / p95 / maximum request latency | 286.41 / 410.06 / 1,629.67 ms |
| Input tokens / API-reported cost | 98,904 / $0.004153968 |
| Returned model on every request | `typesafe/jev-1.13-20260917` |

Artifacts: [frozen fixtures and runner](jev-2026-09-21/mail-probe.py), [complete requests, answers, distributions and summary](jev-2026-09-21/mail-probe-results.json). The earlier 56-call smoke test is separate and is not pooled into these measurements.

The five disagreements repeated consistently:

| Case | Expected / actual | Interpretation |
| --- | --- | --- |
| “I will send you the signed agreement tomorrow. Nothing you need to do.” | waiting on other / none | A material state-tracking miss. The question's emphasis on the owner's action also conflicts with its waiting-on-other option. First-run probabilities were 0.51 none and 0.49 waiting; separate those questions in a future development set. |
| Human support requests invoice number to fix duplicate entry | no new material change / material change | “Existing problem” versus “newly reported change” needs a clearer boundary and prior state. Jev correctly recognized the human reply request. |
| Action instructions in an unavailable attachment | conversation / unclear purpose | The expected purpose is debatable; importantly, Jev preserved unclear obligation rather than inventing completion or content. |
| Athletics promotion for a budget-conversation query | related / unrelated | A strict label disagreement about shared entity versus topic. It still rejected the promotion as a direct answer. |
| Budget conversation for an athletics-advertisement query | related / unrelated | Same boundary issue. It correctly selected the requested advertisement in the positive counterpart. |

No labels were edited and no prompts were tuned after seeing these results. A post-hoc binary check of direct versus non-direct search match was correct for all 12 unique search candidates; that easier check is not the predeclared four-way score and is not an end-to-end retrieval benchmark. Three repeats of 40 short examples do not establish production accuracy, calibration, or a deterministic guarantee. This did not test attachment reading, long mixed threads, multi-obligation threads, retrieval recall, large candidate sets, sustained load or production failure rates. Timing includes this environment and OpenRouter.

Jev provides bounded typed outputs, but its documentation describes limits with indirect reasoning, irrelevant context, adversarial content and structural consistency between independently asked questions. Keep exact date comparison and arithmetic in code. Persist accepted results so repeated rendering does not rerun the model or jitter ordering. Stable stored classifications and stable sort rules can be deterministic product behavior even though the model's probabilities vary. [Jev limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13)

**Build a shared set of mail facts with separate responsibilities.**

| Information | Owner | Why it matters |
| --- | --- | --- |
| Account, sender address, recipients, timestamps, message order, List-ID, attachments, self identity | Provider/parser and code | A display name, To-address or same domain is not proof of a personal relationship. Preserve real headers instead of searching only snippets for list markers. |
| Exact-address interaction history, explicit VIP/list preferences, user corrections, linked work/booking | Application data | A university is not one relationship. Corrections should target a message, sender or list according to the user's chosen scope. |
| Communicative purpose, request or promise, responsible actor, cancellation/completion, relation to an existing transaction | Jev evaluated against small, relevant evidence | These are semantic classifications, not free-form importance guesses. Separate factual signal from display policy. |
| Evidence IDs, deadline candidates, transaction candidates | Parser or extraction stage, then Jev selection/verification | Code validates selected source IDs and copies source spans. Missing candidates produce unknown; they must not force a match. |
| Resolved dates, overdue status, authorization, user-rule precedence, section eligibility, budgets, stable tie breaks | Code | These are reproducible product rules. The classifier does not send, archive, pay or otherwise execute an action. |
| Explanation sentence | Template or existing prose model | It describes the accepted facts and selected item. It cannot promote an excluded candidate by writing a compelling explanation. |

A stored semantic result should carry user/account/thread scope, source message IDs and revisions, question and model versions, evaluation status, typed answers, probabilities, and validated evidence references. Keep stable purpose separate from live obligation state and from query-specific search relevance. Invalidate the affected state when a relevant new message, correction, work update or source revision arrives. Recompute date proximity from the current clock without asking the model.

An obligation is its own record: actor, requested act, source span, optional due date, status and completion evidence. One thread can contain several obligations, including simultaneous work for you and a promise from someone else. The probe's single obligation Choice is deliberately simplified and is not a sufficient production schema. A new FYI must not erase an older request; reading does not finish it; a quoted old request must not recreate a resolved task. An outbound “thanks” is not a waiting-on-other state.

The synchronous inbox reads accepted facts from storage. Background evaluation follows synchronization; one evaluated message can serve inbox organization, Brief selection, work matching and notification eligibility. Query relevance is evaluated only for search candidates, with bounded concurrency and a deadline; on failure preserve the best existing retrieval order. Do not call Jev per row whenever the user opens a screen.

**The resulting features should be concrete and independently testable.**

| Feature | Behavior the user should get | Required classification/state |
| --- | --- | --- |
| A Brief without filler | Show consequential unresolved actions and meaningful changes. Say nothing new needs attention when appropriate. An ordinary game advertisement does not qualify merely because it arrived today. | Purpose, obligation, consequence, explicit personal relevance; an eligibility gate before scoring |
| Actual “Needs your reply” | Questions and requests assigned to you, excluding thanks, resolved asks, FYI, optional sales responses and requests directed to other recipients | Request, actor, outstanding/resolved state, evidence |
| “Waiting for” with an expected outcome | A signed agreement, response or deliverable someone owes you, with aging and an appropriate follow-up opportunity | Promise/asked-for outcome, counterparty, completion state; elapsed time in code |
| Required work without an email reply | Upload slides, renew an account or update failed payment separately from replying to a person | Action type and owner; one canonical task linked to the email |
| Important automated changes | A changed ticket time, payment failure or actual account lock can surface despite no-reply or Updates labels | Existing transaction/account link and concrete change; provider trust handled separately |
| Quiet ordinary transactions | Receipts and routine confirmations remain findable without becoming urgent Brief items | Receipt/confirmation state without new action or consequence |
| Personal conversation and list organization | Actual support conversations can remain visible even from `support@`; sports and fundraising campaigns can stay in their own lists | Purpose plus exact relationship and List-ID, not address stereotypes |
| Search for the thing you meant | Find an approval conversation, final signed document or issued refund before topical near-matches; still find promotions when requested | Query/candidate relationship and document state, applied before final clipping |
| A visible unresolved backlog | Brief highlights remain short, but all remaining relevant actions have a count and a complete view; critical items do not become “noise” through lane caps | Persistent obligations, surfaced versus unresolved distinction |
| Corrections that stick across surfaces | “Keep this list out of my Brief” affects subsequent editions while preserving messages and their explicit searchability; do not mute the whole university by inference | Versioned, scoped user policy shared by all consumers |
| Useful explanations | “Alex asked you to approve the budget; you have not replied,” with the supporting message available | Validated source span and reason code, not invented urgency |
| Brief updates without repeats | Resolved obligations disappear from current attention views; previously seen unchanged FYI stays quiet; genuinely new changes reappear | Last surfaced state, source revisions and obligation transitions |

For the Syracuse family of cases, the intended policy is explicit:

| Email/context | Brief | Mail organization | Search |
| --- | --- | --- | --- |
| General game promotion, no relevant preference or purchase | Exclude | Athletics/list/promotions | Return when query requests it |
| Existing purchased ticket changes time | Surface the change when relevant | Ticket/transaction | Match ticket and scheduling queries |
| Same institution, professor asks for approval | Surface if unresolved and assigned to you | Conversation / needs reply | Prioritize for that approval conversation |
| Routine ticket receipt | Normally quiet; available in transaction history | Receipt | Direct hit for receipt/order lookup |
| User explicitly wants athletics updates in Brief | Respect that preference at its chosen priority | Same content classification | Same query-specific behavior |

This is a product proposal. It is not evidence that the historical Syracuse message had any particular headers, label, prior relationship or purchased-ticket context.

**Reuse the same facts across Albatross after the mail path works.** A request can propose a Work item, with source evidence and deduplication against the existing obligation. A booking change can update a calendar review queue using parsed dates and identifiers. An issued refund or delivered document can be evidence for an existing tracked outcome; it should not automatically count as completion merely because it shares words with the task. Area views can show changed matters relevant to that Area, and notification policy can reserve interruptions for time-sensitive consequential events. Narrative can record a confirmed transition instead of repeatedly summarizing the same email. These extensions need their own acceptance criteria, but they should consume one versioned fact record rather than invent independent classifications.

**Implementation order should fix the existing defects before expanding model scope.**

1. **Repair Brief eligibility and observability.** Trace every considered item through retrieval, classification, eligibility, scoring and display. Stop domain-wide relationship promotion by default. Separate bulk purpose from consequential automation. Remove direction-only reply/follow-up duties. Replace the uncorrectable human floor with evidence-based protection. Keep all unresolved actions available beyond the highlight budget. Add the reproduced examples as focused regression tests when changing behavior.
2. **Unify classification storage and add Jev in shadow.** Use account-scoped identities and one accepted semantic record. Compare Jev, current rules and current model using equivalent evidence. Separate uncertain from unavailable; permit bounded retries without a tight loop. Preserve explicit user policy. Start with purpose, request/actor, promise and completion facts rather than a single importance score.
3. **Repair search retrieval and ordering.** Preserve candidate relevance, support selective queries beyond a single window, deduplicate threads without losing matching spans, widen candidates before reranking, and remove unconditional recency sorts from relevant mode. Establish retrieval recall before claiming a reranker helped. Add semantic retrieval only where measured paraphrase recall requires it.
4. **Ship persistent obligations and focused improvements.** Shared needs-reply, waiting-for, action and meaningful-change views can then power the Brief. Update the current edition after relevant state changes; retain historical snapshots and the reason each item appeared. Preserve the current visual design while behavioral work lands.
5. **Expand to Work, Areas, calendar and notifications.** Reuse proven facts; evaluate completion and interruption rules separately. Do not use low cost as a reason to add an unmeasured classifier to every operation.

The first three are separate changes with focused behavioral tests and instrumentation. A smaller staged rollout can improve the current product before all new views exist. Any material web UI redesign should follow the repository's Mobbin and browser research requirement; this investigation makes no UI changes.

**Define excellent sorting in terms that can fail a release.**

| Measure | What to evaluate | Proposed starting acceptance condition, not a measured result |
| --- | --- | --- |
| Candidate recall | Was each labeled important item available to the classifier/ranker at all? | No known critical omission in the regression set; separately measure older unanswered and multi-account cases |
| Brief precision | Of displayed items, how many the user says deserved a slot that day? | Aim for at least 98% on an adjudicated held-out set, plus no known campaign leakage in the explicit regression cases |
| Action recall | Are unresolved assigned requests/actions available, including beyond highlights? | Aim for at least 99%; report misses separately from harmless label disagreements |
| Search quality | First useful result, reciprocal rank and nDCG on actual user intents | Every known regression pair passes; improved held-out ranking without losing explicit promotion/receipt queries |
| State accuracy | Completed, delegated, quoted and read-but-unanswered cases | Exact transition assertions; no re-created completed tasks or direction-only follow-ups |
| Personalization | Correction scope and propagation | Repeated excluded-list Brief appearances fail; same-domain individual conversations stay eligible |
| Reliability and speed | Cache latency, ingestion lag, live-search p50/p95/p99, failures and fallback quality | Proposed cached classification reads add no network model wait; set live-search and ingestion budgets from production measurements |

Construct an initial evaluation from at least 500 diverse, adjudicated mail/thread snapshots and a separate set of real search intents. Include several days of complete candidate pools, not just the selected winners. Preserve what was known at each historical edition: later replies are future information and must not leak into a retrospective judgment. Hold out later time periods, whole threads and sender/template families to reduce leakage. Label campaign-versus-conversation, new senders, automated consequences, ambiguous attachments, multiple accounts and explicit preferences. Report uncertainty intervals and per-slice results; repeated synthetic calls do not expand the number of independent examples.

Use development examples to refine the currently ambiguous questions, then freeze prompts, options, thresholds and code before the held-out evaluation. The 0.5 cutoff used in this probe is a measurement convention, not a deployment threshold. Critical suppression deserves a different error tradeoff from harmless folder labeling. Unknown items should remain discoverable and should be reconsidered when missing evidence arrives.

The practical promise is **predictable rules, measured relevance, fast updates and corrections that hold**. Absolute semantic perfection is not established by Jev's documentation or these experiments. The current code already shows that perfectly repeatable classifications can still produce the wrong Brief when eligibility, state tracking and ranking are wrong.
