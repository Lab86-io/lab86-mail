# Connected content and prepared Brief work

Research and implementation: 2026-09-21. Builds on the staged fixed-provider Jev mail work in PRs #276–278. The earlier Main / Needs reply / Noise navigation and Settings → Jev live mail demo remain the mail entry points.

## Product behavior

- The current Brief admits new qualifying mail and rechecks existing mail every 30 seconds while open. The saved morning edition and history are unchanged. Promotional broadcasts do not get a free pass because they are recent.
- Supported content is downloaded and indexed progressively from connected Google Drive/OneDrive files, mail attachments, stored mail, Albatross documents, and connected-tool items. Extended Slack/Jira history uses only advertised paging arguments; Granola meeting details are fetched in bounded batches. GitHub/Bitbucket content uses the existing stored feed.
- Native search reads indexed body text immediately. A separate semantic request adds paraphrase matches. Files remain in Files, tool content appears in Connected tools, and duplicate document/cloud hits are merged. The agent has `content_search` for the same corpus.
- Jev supplies typed classifications and candidate work matches. The owner's saved name/email and connected mailbox addresses are supplied as identity context. Jev never writes the SBAR or draft files.
- A writing model proposes targeted research queries, retrieves connected evidence, then prepares a shaped suggestion, SBAR, questions, steps and useful Markdown/text/CSV files. These remain in **Prepared for you** in the current Brief. No Work or library document is created until adoption.
- Adopt creates the shaped work and documents atomically, or appends research to a matched existing active work item. Research and draft files are attached as context, not completion proof. List/practice/monitor/recurring shapes receive no execution plan.
- Dismissals persist. Source changes require refresh. Saved file edits survive regeneration; unsaved edits survive card refreshes. Concurrent user notes invalidate an in-flight generation. Every researched source version is checked before a preparation is accepted or adopted.
- Settings → Jev now shows sync/preparation switches, sampled classification/search coverage, connector status, partial reads and Sync now. There is no classifier picker.

## Research and design decisions

Browserbase was used for browser-based product research, including Notion's enterprise search page and the Mobbin Melio settings reference. The Mobbin MCP was unavailable; the direct page exposed only its wrapper in this session. The prior Jev research had inspected the Melio settings image. No additional visual findings are inferred from that wrapper.

- [Notion enterprise search](https://www.notion.com/help/enterprise-search): connected-source filters and source citations informed the decision to keep origin, exact quotes and coverage visible instead of presenting unsupported conclusions as facts.
- [Melio settings reference on Mobbin](https://mobbin.com/screens/ac45719a-952f-44c6-9bcc-ce8ce1580b36): preserve compact grouped settings rows, existing Albatross tokens and density. New controls sit inside Jev settings; prepared work uses the Brief's existing reading column and buttons.
- [Google Drive change feeds](https://developers.google.com/workspace/drive/api/guides/manage-changes): obtain the starting token before backfill, retain continuation state, process removals, and reconcile a completed census after cursor expiry.
- [Microsoft Graph drive delta](https://learn.microsoft.com/en-us/graph/api/driveitem-delta?view=graph-rest-1.0): retain provider continuation URLs, handle deleted items, and restart/reconcile expired cursors. Continuations are restricted to the expected Graph origin and drive paths.
- [Google Drive downloads and exports](https://developers.google.com/workspace/drive/api/guides/manage-downloads): export native Docs/Sheets/Slides to text or Office formats; stream other supported files with an 8 MiB actual-byte cap.
- [Convex vector search](https://docs.convex.dev/search/vector-search): user-filtered chunk vectors with a second owner/access/version check when materializing results. Exact search remains available during embedding outages.
- [OpenRouter embeddings API](https://openrouter.ai/docs/api/api-reference/embeddings/create-embeddings), [text-embedding-3-small pricing](https://openrouter.ai/openai/text-embedding-3-small): fixed 1,536-dimensional embeddings; metered at the catalog's $0.02/M input tokens. Embeddings are a separate retrieval step from Jev.
- [PDF.js examples](https://mozilla.github.io/pdf.js/examples/): extract selectable PDF text; scanned/no-text documents are explicitly partial.

## Live demonstration

Run `OPENROUTER_API_KEY=… bun scripts/demo-connected-content.ts` in a trusted local environment. It uses synthetic source material and live providers, with a fixed synthetic research corpus. It does not read or change a user's account. Provider credentials are never part of the evidence files.

[Live model evidence](connected-content-2026-09-21/live-model-evidence.json) records nine Jev calls, four embeddings and a two-stage writing-model preparation:

- Jev: 234–544 ms per call. The personal launch request was actionable on all three repeats; the athletics promotion was noise on all three; the completed task was resolved on all three.
- Routing labels were stable in this small sample, but the request's confidence varied (0.65–0.66). This is evidence of fast classification, **not perfect accuracy or bit-for-bit determinism**.
- Four source embeddings: 696 ms.
- Research-query generation: 2,955 ms. SBAR/files generation: 11,708 ms. The generated draft passed exact-quote validation against supplied sources.
- The first live attempt exposed an unsupported Unicode filename regex in the writing-model schema; the schema now uses a provider-compatible filename pattern. A second finding—missing owner identity—was fixed before recording the final demonstration.

The faster path is cached classification and local indexed retrieval during use. These timings do not establish an end-to-end speedup over the previous product. The historical Syracuse Athletics Brief has not been retrieved or replayed.

## Verification evidence

The preview uses the real PreparedWork and ContentSettings components with a synthetic HTTP transport. It is not a screenshot of a signed-in staging account.

- [390 px screenshot](connected-content-2026-09-21/brief-390.png)
- [1440 px screenshot](connected-content-2026-09-21/brief-1440.png)
- [Browser assertions at 390/768/1440 px](connected-content-2026-09-21/evidence.json): answers can regenerate untouched files, source refresh preserves unsaved edits, saved edits survive regeneration, download filename is correct, adoption links to Work, dismissal persists, settings persist, failures are visible, no horizontal overflow or browser exceptions.
- Focused tests exercise owner isolation, stale vectors, source versions, leases, deletion census, cloud pagination, transient errors, classification/embedding failures, provider schema capabilities, draft revision conflicts, atomic adoption, no-plan shapes, real PDF and Office extraction, and native-search deduplication.
- Every new `lib/content` module exceeded the repository's 70% line-coverage requirement in the focused run.

Full regression run: 4,252 passed, 1 skipped, 0 failed across 446 files (36,188 assertions). Typecheck, lint, build and deployment results are recorded in the PR.

## Coverage and rollout limits

Indexing is progressive; the first run does not imply complete history. Workers use durable leases, bounded pages and a two-minute cron. Mail's existing Jev sweep also kicks the content cycle after new classifications. New content gets half the classification batch; older pending content keeps the other half.

Supported reads are capped at 8 MiB, 120,000 characters, 80 PDF pages and 100 Office XML entries. Scans requiring OCR, unsupported binaries and oversize files remain partial. Large sources are researched through explicitly marked excerpts. MCP search windows may be incomplete or shift while paging; Settings reports provider-limited coverage rather than claiming a complete archive. Access changes take effect through current connection checks and provider feeds; cloud census reconciliation removes files missing after a completed rescan.

At most three pending proposals are prepared, one generation per cycle. Preparation initially considers recent indexed sources, then researches across the corpus. Existing Work matching is a classification candidate, not an autonomous adoption decision. Drafts can require review and corrections; generated source quotes are validated, but that does not prove every inference in a draft.
