# Simpler Mail and a live Jev demonstration

The main Mail strip now has three categories: **Main, Needs reply, Noise**. One More menu holds detailed attention views, codes, orders, finance/admin, review, custom views and mail folders. Every existing view remains reachable, including a selected persisted custom view. Category selection takes precedence over an old folder query. The mobile strip shows all three categories together; Compose becomes a labeled icon and counts remain on desktop.

Settings → Jev now includes **Try Jev live**. Four editable synthetic examples demonstrate a promotion, a personal approval request, a completed request and a cancelled purchased ticket. Clicking Classify live calls the fixed Jev runtime using the authenticated user's credential and budget policy, the production mail questions, source-evidence validation and Brief eligibility function. It reports model-request time, category, open obligations, evidence, uncertainty and Brief eligibility. No mailbox rows or classification settings are changed. Usage and rate limits are recorded. Demo examples use current Brief preferences; sender/thread corrections are intentionally reserved for actual mail. A demo can run while automatic incoming classification is paused because clicking it is an explicit one-off request.

## Observed live behavior

The [CLI run](jev-live-demo/results.json) and [browser run](jev-live-demo/browser-evidence.json) both made real provider calls with synthetic messages. Browser results:

| Example | Result | Brief eligibility | Model request |
| --- | --- | --- | --- |
| Athletics promotion | Noise, no obligation | Excluded | 420 ms |
| Personal approval request | Main, reply owed | Eligible | 294 ms |
| Approval already sent | No open obligation | Excluded | 251 ms |
| Purchased train cancelled | Main, material change | Eligible | 572 ms |

The approval result carried an uncertainty flag; the UI displays it. Eligibility does not guarantee placement in a finite Brief. These examples are demonstrations, not held-out accuracy statistics or an end-to-end latency SLA. The actual historical Syracuse Brief has not been replayed. [Approval screenshot](jev-live-demo/demo-approval.png), [mobile navigation](jev-live-demo/mail-mobile.png).

## What is faster, and what happens on arrival

A verified Nylas webhook is acknowledged, then processed by the existing ingest queue. Corpus upsert invalidates the assessment when the conversation's source content changes. `kickMailClassifiers` dispatches the Jev worker with its normal five-second debounce; it classifies bounded conversation context and stores the result. The Convex five-minute retry job catches missed work. Classification requires enabled preferences and usable AI credentials/budget; failure and missing context are exposed. Some reconciliation/hydration paths rely on the scheduled sweep rather than an immediate kick. The demo request time does not include provider delivery, sync, queueing, persistence or UI propagation.

The reusable stored assessment avoids another model classification each time Mail or the Brief reads the conversation. That is the architectural latency saving. No before/after benchmark of the old production classifier or whole Brief/search response has been established. Interactive search adds a bounded model rerank, with a two-second deadline and retrieval fallback; the benefit being claimed for that path is relevance, not a measured wall-clock speedup. Jev handles mail categories and facts; prose generation and the separate Area classifier still have their own paths.

## Product research

Applied the Mobbin research skill. Mobbin MCP search tools were unavailable; Browserbase inspected the existing [Notion Mail web reference](https://mobbin.com/screens/bb6aa516-50ce-4b33-90e4-a944bed414fb), and local Chromium loaded its visible screenshot for visual verification. The screen separates Views from Mail folders, with compact rows and a small filter toolbar. We retain Albatross's existing density and 48-pixel header, and use one grouped menu for secondary navigation.

Browserbase also inspected [Superhuman's Structure Your Inbox](https://help.superhuman.com/hc/en-us/articles/46005793275277-Structure-Your-Inbox). Its documented Important/Other split and optional additional views support keeping the default decision set small. Albatross retains its existing Main/Needs reply/Noise meanings rather than adopting a new taxonomy or refiling mail.

## Validation

Focused route tests cover authenticated scope, production questions, strict and bounded inputs, no model override, rate limits, sanitized failures, usage reporting, Brief preferences, source evidence and resolved obligations. Navigation tests cover category/folder precedence and custom views. The complete suite passed **4,221 tests**, with one existing skip and no failures; the two new library modules have 100% line coverage. Typecheck passed. Lint has only the repository's existing warning/information diagnostics.

`scripts/verify-jev-demo.mjs` exercised all detailed views and folders, active selection, mobile fit, the four live provider examples, failure recovery and missing-setup state at 390/768/1440 pixels, with no page errors. A loopback preview uses the actual components; its settings transport is synthetic. This is not a claim of signed-in staging browser verification. Release uses the existing staging workflow and subsequent deployment/API smoke checks.
