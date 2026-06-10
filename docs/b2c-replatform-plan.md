# lab86-mail B2C Replatform Plan

*Drafted 2026-06-10. Targets: Railway + Convex only. Tailnet variant and GOG are dead.
Driving goals: iCloud (and any Nylas provider) support, local-first search, B2C readiness.*

## Decisions locked

| Decision | Choice |
|---|---|
| Account identity | Nylas/provider `grantId` is the machine key everywhere; email is display-only |
| Search | Internal AST; **local Convex index is the primary search path for ALL providers** (no Microsoft KQL compiler, ever); Nylas structured params as cold-start fallback |
| Sync | Full-history backfill per account; webhooks/push as wake signal + watermark reconciler as source of truth |
| Provider transport endgame | Direct APIs (Gmail API, MS Graph, ImapFlow for iCloud); Nylas demoted to interim IMAP transport, then removed |
| Compliance | Own our Google verification + CASA Tier 2 on our own GCP project; defer the spend until launch trigger |
| Pricing | One tier, $15/mo or $120/yr; flat-feeling; hidden credits meter only expensive AI |
| AI | Router (OpenAI + Anthropic via OpenRouter/direct); every routed vendor needs no-training terms |

## Phase 1 — Identity (prerequisite for everything)

1. New stable key: `grantId` replaces `accountId = userId:email` (convex/lib.ts:15).
2. Delete the Google-wins collision branch in `upsertConnectedAccount` (convex/accounts.ts:105-110); same email on two providers = two accounts.
3. Migrate Convex rows (connectedAccounts, providerGrants); thread `grantId` through all ~24 tool inputs, Nylas provider layer, Zustand client state (graceful fallback for persisted email strings), attachments route.
4. Tests: two same-email accounts stay distinct.

## Phase 2 — Search AST + execution plans

1. AST node set from actual app needs: folder, unread, starred, important, attachment, from/to, subject, date-range, OR-group, negation, free text.
2. Compiler returns `{ queryParams, dropped[] }` per account capability tier:
   - `local` (target for all providers) — query our Convex corpus
   - `structured` — Nylas params (from/to/subject/unread/starred/has_attachment/in/latest_message_before/after) — universal fallback while backfill incomplete
   - `native` (Gmail only, interim) — `search_query_native`, companions limited to in/limit/page_token
3. NL search LLM emits AST JSON directly (kill NL→Gmail-string translation). Small Gmail-operator parser for typed syntax.
4. Convert hardcoded Gmail strings to AST constants: default query, CommandPalette shortcuts, smart categories, daily-report queries. Per-tier degradation explicit in `dropped`.
5. Frontend: one search bar sends `{ query, accounts }`; all compilation server-side.
6. Gate/remove the GOG fallback in search_threads (GOG is dead).

## Phase 3 — Sync engine (the big subsystem)

Schema (Convex): messages table keyed (userId, grantId, messageId); fields for folders, flags,
from/to/cc, subject, receivedAt, snippet, extracted text (strip HTML, cap ~16-32KB), `searchText`
concat field with searchIndex (filterFields: userId, grantId; equality-only — add `yearMonth`
bucket for date scoping). Threads derived from messages (no thread webhooks exist).
Design constraints (verified): Convex search = 1 searchField, 1024-result scan window,
relevance-only order (take-then-sort for newest-first), fuzzy deprecated; mutations capped
16 MiB / 16k docs / 1s → batched writer driven from actions; staged indexes for backfill.

1. Per-account supervised sync unit with per-folder cursors (deltaLink / historyId / UID).
2. Full-history backfill job: paginated, resumable, progress UI (Gmail ≈ 1-4h+/account through rate limits).
3. Incremental: webhook/push wake → pull changes; **watermark reconciliation cron is mandatory** (Nylas has NO replay; 3 retries then events are gone; handle `message.created.truncated` re-fetch).
4. Write-through on mutations (mark read/star/archive) — optimistic local + provider call.
5. Delete-on-disconnect cascade: grant removal purges corpus, tokens, derived data (CASA + GDPR requirement).

## Phase 4 — Flip search to local

Capability table flips providers to `local` once their backfill completes; `structured`/`native`
fallback during cold start. Smart categories + daily report consume the local corpus
(classify on ingest, not on query).

## Phase 5 — Direct provider drivers (Nylas exit)

Order: **Gmail → Graph → IMAP**. Driver interface already exists from Phase 3 (sync unit + cursors).
- Gmail: googleapis, format=FULL, history.list delta (replayable ~1wk), users.watch + Pub/Sub (renew daily; Pub/Sub free at our scale). New-2026 quotas: messages.get = 20 units, ~300 gets/min/user; 100k-msg backfill ≈ 5.5h.
- Graph: per-folder delta tokens (replayable) + change notifications w/ lifecycle events; 10k req/10min/mailbox, 4 concurrent; $batch ≤20.
- iCloud: ImapFlow + mailparser; UID cursors + periodic flag reconciliation (CONDSTORE/QRESYNC advertised but flaky on iCloud); ≤2-3 connections/account (1 INBOX IDLE + 1 worker); SMTP smtp.mail.me.com w/ app-specific password (encrypt like tokens; 1k sends/day cap).
- Nylas stays as the IMAP driver until ImapFlow driver lands, then cancel ($15/mo flat meanwhile). Switching OAuth transport forces per-account re-auth → do Gmail/Graph cutover while user count is small.

## Phase 6 — Compliance / B2C readiness

**Free now (build into the refactor):** delete-on-disconnect (Phase 3); tokens + app passwords
encrypted at rest (Convex AES-256 covers storage; field encryption already present); privacy
policy + ToS + Google Limited Use statement + app homepage; scope = gmail.modify only;
multi-tenant hardening (userId-scoped queries, per-user rate limits); breach runbook
(GDPR 72h + security@google.com); DPAs (Convex, Nylas); no-training terms verified for every
router vendor; self-serve account deletion; production GCP project (the 100-user cap is
LIFETIME per project — don't burn it on demos).

**Deferred until launch trigger:** Microsoft Partner Center + publisher verification (free, ~1wk);
Google brand verification (free, days) → restricted-scope review (~6wk) → CASA Tier 2
(try free self-scan; else TAC ~$540-720/yr). Total ~2-3 months.

**Trigger:** start verification at public-launch decision OR ~70 lifetime Gmail sign-ins,
whichever first. Until then: app "In production" + unverified (NOT Testing status — 7-day
refresh-token expiry breaks sync); testers click through the warning.

**The cliff:** user #101 (lifetime, per project) disables Google sign-in entirely; unrecoverable
without a new GCP project + full re-auth.

## Phase 7 — Billing & AI credits

### Grounded token costs (verified 2026-06-10)

| Model | Input $/Mtok | Output $/Mtok | Cached in | Batch |
|---|---|---|---|---|
| GPT-5.5 (big, OpenAI) | $5.00 | $30.00 | $0.50 | 50% off |
| GPT-5.4-mini (small, OpenAI) | $0.75 | $4.50 | $0.075 | 50% off |
| Claude Opus 4.8 (big, Anthropic) | $5.00 | $25.00 | ~0.1× reads | 50% off |
| Claude Sonnet 4.6 (mid, Anthropic) | $3.00 | $15.00 | ~0.1× reads | 50% off |
| Claude Haiku 4.5 (small, Anthropic) | $1.00 | $5.00 | ~0.1× reads | 50% off |

### Credit design (internal only — never shown to users)

- **1 credit = $0.01 of list-price model cost.** Gateway computes actual cost from usage
  (tokens × per-model rate table incl. cache/batch discounts) and decrements
  `creditsUsed` — the Clerk `monthlyCredits` entitlement plumbing already exists.
- **Allowance: 500 credits/mo on the $15 plan = $5 hard AI ceiling = 33% of revenue.**
  Worst-case contribution: $15 − $5 AI − $2 Nylas-interim − ~$0.50 infra ≈ $7.50/user.
  No usage pattern can cannibalize margin below that.
- Typical spend ≈ 200-300 credits ($2-3), so most users never feel the cap.
- Reference op costs: daily report (small model, batch, 10k in/1k out) ≈ 1 credit;
  ingest classification ≈ 1 credit/day; draft reply (Sonnet, 5k/500) ≈ 2 credits;
  big-model chat turn (GPT-5.5/Opus, 8k/800) ≈ 6-7 credits; Sonnet chat turn ≈ 4.
  500 credits ≈ background features + ~75-100 big-model chat turns.
- **Soft degrade before hard stop:** at 80% spent, route chat to small models; at 100%,
  AI chat pauses (sync/search/reports/triage NEVER pause — they're the product and cost ~$1/mo).
- Background/bulk work pinned to small models + Batch API; chat uses prompt caching
  (repeated mail context → ~0.1× reads). Per-request max_tokens caps as abuse guard.
- BYOK mode bypasses credits (user pays their own AI); potential $8/mo BYOK tier later.

### Unit economics

Fixed: Convex Pro $25 + Railway ~$15 + Nylas $15 + CASA ~$50 (post-verification) ≈ **$105-125/mo**.
Break-even ≈ 13 paying users. CASA = 4-5 annual subscriptions. Annual plan funds compliance cash flow.

## Phase 8 — Markdown fix (independent, separate commit)

Two renderers exist (components/ui/markdown.tsx block-splitting + Streamdown in
ai-elements/message.tsx). Identify which surface actually breaks lists, consolidate on
Streamdown (handles streaming + GFM natively).

## Validation & shipping

- bun test: compiler matrix (per tier: compiles-to, dropped[]), param-allowlist invariant,
  identity distinctness, credit costing math, delete-cascade completeness.
- Verify empirically with real Microsoft + iCloud grants before hardening the capability table.
- Ship via staging → PR to main → Railway CI (per existing flow).

## Rollout: increments, not phases (decided 2026-06-10)

Hard rule: **no regressions; every increment is a user-visible improvement or ships dark.**
Pure transport rebuilds (Phase 5 direct drivers) are segregated into their own later track —
Google, Microsoft, AND iCloud all run on Nylas until everything works, then providers cut
over to hand-rolled drivers individually.

**Increment A — Markdown fix.** Independent, zero mail-path risk. Warm-up ship.

**Increment B — Identity (grantId).** Improvement: same-email Google+Microsoft accounts
coexist instead of Microsoft being silently dropped. Regression guard: account resolver
accepts grantId OR email during transition (logs deprecated email lookups); persisted client
state migrates lazily; manual checklist (inbox, thread, send, mutations, labels, daily report)
on staging before merge.

**Increment C — AST + server-side compilation (native for Google, structured for MS/iCloud).**
Improvement: Microsoft/iCloud search stops receiving raw Gmail syntax; one search bar
unchanged. Regression guard for Google: **golden tests pin AST constants to today's exact
Gmail strings byte-for-byte** (default query, palette, smart categories, daily report); user-typed
Gmail syntax on Google accounts passes through verbatim (parse only for non-native tiers) so
power-user behavior is provably identical.

**Increment D — Sync engine, shipped DARK.** Messages table, backfill, webhooks, reconciler,
delete-on-disconnect cascade — running in shadow; no read path touches it. Zero regression
surface. Validate corpus by sampling against Nylas reads on our own accounts.

**Increment E — Local-first flip, per provider, behind the capability table.** Flip order:
iCloud first (current state is worst, win is biggest), Microsoft second, Google LAST and only
after parity is proven — Gmail native search is excellent today, so Google keeps `native` until
local demonstrably matches it. Per-provider flag = instant rollback; `structured`/`native`
remain permanent fallbacks so local failures degrade instead of break.

**Increment F — Billing + credits.** Additive (Clerk entitlement plumbing exists); doesn't
touch mail paths. Anytime after E, or parallel.

**Track 2 (separate, later) — Phase 5 direct drivers.** Pure rebuild of working transport;
own branch/PRs, one provider at a time (Gmail → Graph → ImapFlow), each behind the driver
interface with Nylas rollback until soak passes. Mind the clock only loosely: per-provider
cutover forces re-auth for that provider's accounts, so cheaper before user count grows.

Compliance code rides the increments (cascade in D, policy pages anytime); paid verification
stays on its trigger (launch decision or ~70 lifetime Gmail sign-ins).
