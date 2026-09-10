# Albatross platform direction

## Executive judgment

Albatross has a credible center: remember the commitments and context a person would otherwise keep reconstructing, explain what changed, and help move one important thing forward. Its strongest opportunity is not replacing mail, calendars, drives, task managers, and document editors. It is making the relationship between those systems useful to one person over time.

The narrative spine is a meaningful architectural step toward that product. Task-specific retrieval, source links, explicit intentions, corrections, and grounded Work identity are stronger foundations than a generic chat box with more connectors. But the product still presents several independent subsystems as if they formed one coherent workspace. Files makes this particularly visible.

**Recommendation: move the standalone Files explorer and general-purpose document authoring into an experimental capability, independently gate external document write-back, and preserve attachments, existing deliverables, source links, and safe read access. Then concentrate on one complete daily loop across web and native clients.** This is a scope reduction, not abandonment of documents.

This judgment is based on the inspected implementation and targeted checks, not usage analytics or a claim of product-market fit. There is enough substance to justify further development. There is not enough evidence to justify adding more surface area before the core experience becomes dependable.

## The original promise

The product direction that emerged was unusually specific:

1. Make finding and moving between things effortless, especially from the keyboard.
2. Make Areas places to understand a responsibility and handle its incoming work, not another navigation chore.
3. Make Today a personal brief rather than a generic dashboard.
4. Build that brief from yesterday's stated intentions, observed changes, meetings, development work, email, and the person's own corrections.
5. Retain an account across days, weeks, and months so every conversation does not start from zero.
6. Let chat, Albatross planning, search, and guided work use relevant slices of that account through tools.
7. Turn understanding into a concrete next move, without turning suggestions into commitments or treating generated prose as proof.

The simplest product promise is therefore: **“Remember what matters, show me what changed, and help me carry it forward.”** This is a better organizing principle than “all your productivity apps in one place.”

The distinction matters for the intended audience. A product built for its creator can expose internal categories and tolerate manual recovery. A product useful to someone who discovers it must make its boundaries legible without explanation. Fewer dependable capabilities can serve both audiences; a broad but uneven suite usually serves neither well.

## What is genuinely built

| Layer | Evidence in the current implementation | Remaining product gap |
|---|---|---|
| Narrative memory | Source-backed observations, permission-aware reads, day/week/month organization, age tiers, corrections and bounded retrieval | A representative account is not complete knowledge of a life; coverage must remain visible |
| Context reuse | Chat and Work planning call narrative retrieval; consumer-specific context packets distinguish chat, work, brief, meeting, compose, and search | Consumers still compose and navigate through different contracts |
| Work | Durable identities, explicit states, tool-result reconciliation, artifacts, and a verification vocabulary | Users need one understandable next move and a clear receipt for what actually happened |
| Today | Narrative prose, weather, up to three source-backed threads, Work links, suggestions, correction/defer controls | The new workspace is layered into the existing brief rather than being one unified planning projection |
| Search | Floating web overlay, page navigation, mail/calendar/files/narrative queries, keyboard controls, partial-source warnings | “Everything” lacks direct first-class Work/Area entity retrieval in the inspected overlay; file depth is uneven |
| Files | Cloud OAuth/browsing, uploads, device picker, internal documents, Google editing and export | Discovery, reading, saving, and narrative participation are not equivalent across those sources |
| Native delivery | Existing native narrative/source views and domain-specific search | The new universal search and actionable Today workspace are not native feature-parity releases |

The context boundary is worth protecting. The implementation uses bounded evidence packets and rechecks source visibility; it does not simply prepend the entire history. Chat uses narrative context, and Work planning attaches narrative references. These are concrete integrations, not merely a future architecture diagram.[^1][^2]

Compaction also exists, but its contract is deliberately limited. Detailed recent history gives way to weekly and monthly overviews, while original evidence remains available. The selection preserves representative sources and prioritizes corrections/open commitments within bounded capacity. It must not be described as lossless memory or exhaustive longitudinal analysis.[^3]

One historical criticism no longer applies: the inspected onboarding code no longer forces an account with no mailbox away from the product. That is progress toward proving value before demanding configuration. Older audit documents should not be repeated as current findings without checking the implementation.[^4]

## Files: why the experience feels disconnected

### One label conceals four different capabilities

The Files surface merges Albatross documents and uploaded blobs with live Google Drive/OneDrive listings and files selected through a browser folder picker. A person reasonably reads “All files” as a coherent collection. In code, these are separate queries, separate identities, and different open/edit paths. The browser's iCloud-labeled location is an explicit device-folder selection, not a server-synchronized iCloud corpus.[^5]

This is not necessarily a bad intermediate architecture. It is a bad finished-product promise unless the interface makes the distinctions obvious. A person should know whether a file is merely discoverable, readable by the assistant, indexed for search, stored in Albatross, or editable in its original provider. Connecting an account does not establish all five.

### Completeness is currently overstated

The provider adapter requests pages of up to 100 files and returns continuation cursors. The inspected Files surface and cloud-search tool do not consume subsequent cursors. Consequently, a folder with more than one page has no complete browsing path through those consumers. The “All files” view also starts from provider roots rather than recursively enumerating an entire drive.[^5][^6]

Uploads are fetched from an endpoint limited to the 50 most recent files. The search overlay requests up to 200 Albatross documents and filters titles locally; the Files surface separately requests up to 500. These are concrete discovery boundaries, not equivalent views over one exhaustive corpus.[^7][^8]

Google search uses a filename `name contains` query. Local search matches document titles or upload names. The OneDrive path uses Microsoft's provider search and should not be assumed to have identical semantics. The main `corpus_search` tool searches mail and enabled connected-tool items, not a unified file-content index.[^6][^7][^9]

The earlier full-file-corpus plan explicitly describes extraction/chunk indexing that the current research notes defer. The active upload route stores and registers blobs; that is not proof of durable extraction or content search. Attachments may still be usable in a particular chat workflow, but “attached to this conversation” and “available to future narrative retrieval” are different promises.[^8][^10]

### Narrative integration is thinner than the navigation implies

For Albatross documents, the narrative observation currently records the title, kind, and revision and explicitly says it is metadata rather than document content. Cloud search returns provider metadata and URLs. Reading a Google-native file through the agent tool uses an explicit import path; it is not a uniform read-only content operation across every provider and file type.[^9][^11]

That means the presence of Files in the rail does not imply that a changed vendor proposal, PDF, or spreadsheet reliably contributes its substantive changes to tomorrow's account. This is the integration gap to close—not a prettier grid.

### External editing has a demonstrated preservation risk

The Google Doc importer selects paragraph elements and converts their text into a simplified semantic model. Tables are not retained by that conversion. The writer then builds a request to delete the existing document body and insert text from that simplified model. The Google editor autosaves dirty edits after 900 milliseconds.[^12]

A synthetic, fully mocked reproduction supplied a document containing a paragraph and a table. The imported model contained only the paragraph. Passing that model to the update path produced `deleteContentRange` covering the original body followed by insertion of only the paragraph text. No provider calls, real account access, or external writes were performed. This establishes a reachable destructive transformation in the code; it does not establish that a real user's document has already been damaged.

Google's documentation describes deletion of a content range as deletion, not an operation that implicitly preserves unsupported structures. Revision checks prevent some concurrent-edit conflicts; they do not make a lossy conversion safe.[^13]

A separate static concern deserves regression coverage: after a provider-version conflict, the editor refreshes its version reference while retaining the dirty local model, and its queued-save path can submit that model again. A conflict should remain stopped until the person explicitly chooses how to reconcile. This path was inspected, not runtime-reproduced, so it is a risk requiring a focused test rather than a claim of observed overwriting.[^12]

**External write-back is the first capability I would restrict.** Merely removing the Files rail item leaves editor deep links and write APIs intact.

## A safe Files downgrade

Use separate server-owned capabilities rather than one broad switch named `filesEnabled`. The following names are proposed, not existing settings:

| Proposed capability | Default direction | What it controls |
|---|---|---|
| `filesExplorer` | Experimental / allowlisted | General-purpose rail destination and browsing UI |
| `documentAuthoring` | Experimental / allowlisted | Broad doc/sheet/deck creation and editing |
| `externalDocumentWriteback` | Off until preservation/conflict tests pass | Provider-mutating routes and agent tools |
| `fileEvidenceRead` | Preserve where demonstrably supported | Attachments, explicit reads, source links, retrieval |
| `existingArtifactAccess` | Preserve | Viewing, downloading, and exporting already-created deliverables |

A server-resolved capability manifest should inform navigation, search actions, API authorization, tool availability, and native bootstrap. UI flags alone are not permission boundaries. They should also remain separate from source consent: hiding a destination must not enable ingestion, revoke someone's choices, or erase their files.

The downgrade needs deliberate routing. Search currently sends internal documents and Google-native files into the Files surface. Preserve a stable existing-artifact viewer, and send provider-owned files to their original app when internal editing is disabled. A hidden explorer must not turn previously valid search hits, chat attachments, Work artifacts, or saved links into dead ends.[^7]

Keep a small file concept where it belongs: “Sources for this work” and “Deliverables from this work.” Those are contextually meaningful and do not require a replacement for Finder, Drive, Docs, Sheets, or Slides.

Do not delete storage, disconnect accounts, or blanket-disable document endpoints during this change. Introduce the narrower capability boundaries, test existing-data access, and make the experimental label honest.

## The product to build next

### One durable loop, several entry points

The core loop should be:

**State an intention → observe relevant changes → explain the situation → choose a next move → do/review the work → record the result → carry forward what remains.**

Today, search, chat, Areas, and Albatrosses should be different entrances into this loop, not different products that each generate their own interpretation of the user's obligations.

The concrete pilot is: yesterday's reflection says “finish the release”; a meeting identifies an unresolved decision; a repository update changes what is ready; an email changes the expected delivery. Today explains what moved, names the unresolved choice, and opens the exact Work with those sources. The person reviews or acts. Tomorrow distinguishes the completed result, the still-open commitment, and any explicit decision to defer. No fresh task is created merely because the same topic appears in another day's brief.

This is where Albatross could be genuinely useful beyond its creator. It reduces reconstruction and remembering, rather than asking the person to maintain another organizational system.

### Keep narrative prose downstream of durable facts

The “plot of a life” is a powerful design metaphor but an unsafe literal data contract. Digital traces omit offline work, rest, conversations, and intentions never recorded. The product should say “Here is what changed in the sources you shared,” not imply omniscient knowledge or infer personal failings from missing activity.

Treat narrative as an interpretation over evidence and canonical Work state. Preserve the distinction between observation, reported intention, proposal, accepted commitment, and verified outcome. An email being present is not proof that its requested work was completed; a calendar event is not attendance; a generated summary is not independent corroboration.

Reuse existing Work and Area identities for continuity. The new Today workspace currently identifies each thread by its first source observation; that is useful for source-backed cards but is not a stable identity for the same unresolved responsibility across days. Add a lightweight continuing-thread projection only where no existing Work/Area identity fits. Do not create a parallel task database.[^14]

Corrections and explicit deferrals should affect deterministic eligibility and scheduling as well as explanatory prose. A generated paragraph is not a dependable storage mechanism for “don't show this again today.” Audit that user-visible behavior with multi-day scenarios.

### Make Today a single composed edition

Today currently places weather and the narrative workspace inside the existing brief's lead, then continues rendering the older document regions. The workspace has a separate generation step and a short-lived process-local cache. These are sensible incremental implementation choices, but they leave composition, freshness, and identity distributed across layers.[^14][^15]

Move toward one validated daily projection: narrative opening, stable continuing threads, source references, owned Work references, allowed actions, freshness, and coverage. The model may select and explain; the server resolves identities and permitted actions. Web and native clients render their own components from that same contract.

The default edition should be short: what materially changed, what needs the person, and what can move next. Weather is useful ambient information, not the center of the page. A quiet day should stay quiet. Avoid adding more cards just because the renderer supports them.

### Make search the universal entrance

The web overlay is a substantial improvement. The next step is semantic consistency, not another search layout. It should distinguish opening a destination, finding an entity, asking a contextual question, and taking an authorized action. Support direct lookup of Albatrosses and Areas as first-class entities, alongside mail, events, source files, and narrative history.[^7]

Always expose partial coverage. “No matches” is different from “Drive needs reconnect,” “only filenames searched,” or “older uploads aren't included.” Preserve keyboard focus, escape behavior, left/right category switching, and selection across refreshes.

Native parity should mean identical capabilities and durable state, not identical screen layouts. Do not spend the parity effort reproducing an experimental office suite. Prioritize search/navigation, Today, source opening, corrections, selected next moves, and continuing the same Work on another device. Native build and device evidence remain required before calling these first-class.

## Architecture priorities

**1. A source capability contract.** Each connector should state whether it supports discovery, incremental change capture, content reads, content search, opening originals, and writes. Report freshness, cursors, supported types, authentication recovery, and user-selected scope. OAuth makes authorization easier; it does not automatically make the downstream data useful. The inspected connector catalog still uses token mode for GitHub, Bitbucket, and Slack, while Granola uses OAuth.[^16]

**2. A source-reference contract.** Reuse the existing evidence machinery and normalize provider/connection identity, resource identity, version, occurrence time, observation time, access scope, and available content depth. Do not unify every system's storage before providing a coherent contract over them.

**3. Change-driven projections.** Process new or changed evidence with resumable cursors and idempotent updates; use historical chapters as navigation rather than repeated corroboration. Keep compilation and UI rendering separate, and recheck visibility on reads. The existing narrative permission and revision checks are a foundation to extend, not replace.[^1][^3]

**4. Explicit action state.** Actions need an owner, target, proposal/confirmation state, idempotency identity, result receipt, and appropriate undo or recovery path. Reuse existing Work reconciliation and artifact handling. Neither a successful model response nor an attractive generated card proves that the requested outcome occurred.[^2]

**5. An experience-level release gate.** Test a complete scenario across services and clients. Passing types, API shapes, or mocked editor saves is insufficient if the source content is silently dropped. The 73 focused tests run for this review all passed, while the additional synthetic document-preservation check exposed a risk they did not cover.

## Positioning and evidence of value

Granola already offers scoped conversations across meetings and a history of notes. Its documentation also states the boundary: it does not automatically know the person's email, offline tasks, or personal to-do list. Notion offers cross-connected-app search with citations. Raycast provides a focused file-search experience with explicit scope and settings. These are evidence that context retrieval and search are established product categories—not evidence that Albatross cannot succeed.[^17][^18][^19]

The defensible product hypothesis is narrower: **personal continuity tied to the person's own intentions and actual follow-through across systems.** A remembered commitment plus the right source plus an actionable next move is more distinctive than “chat with all your apps.” This is a hypothesis to validate, not a moat already demonstrated.

Use Granola, mail/calendar, and the repository service actually used for a selected Work as the first integrated loop. Complete that loop before expanding connector count. Ask new people for the smallest useful source scope and one real responsibility; show the value before requiring them to configure every Area and model setting.

Measure outcomes rather than content volume: time to resume a responsibility; time to find and open the correct source; useful versus irrelevant surfaced threads; corrections needed; explicit deferrals respected; action completion with a receipt; and whether people voluntarily return the next day. Track source freshness and generation failures alongside those outcomes. Do not use daily activity as a proxy for a person's worth or productivity.

Start with the creator's real daily use, then a small opt-in group with similarly fragmented work. Retention, willingness to entrust a recurring responsibility, and reduced reconstruction effort would justify investment. This review contains no live usage cohort analysis, customer interviews, revenue evidence, or measured market demand.

## Recommended sequence and acceptance

| Priority | Increment | Completion evidence |
|---|---|---|
| P0 | Restrict unsafe external editing; preserve existing assets | Mixed-content files cannot be silently rewritten; conflicts require explicit resolution; downloads and source links still work |
| P1 | Move explorer/office authoring to experimental capabilities | Navigation, direct links, search, APIs, agent tools, and client capabilities agree; no data or consent changes |
| P1 | Publish honest connector coverage | Paginated discovery, explicit unsupported-content states, reconnect handling, and source freshness tested |
| P1 | One intention-to-outcome daily loop | Yesterday's intention and today's changes produce the correct continuing Work; defer/correct/complete behavior survives refresh and the next day |
| P2 | Shared Today/search contract with native parity | Same entities/actions/permissions; web, iPhone, and Mac builds plus device-level navigation and state checks |
| P2 | Contextual document reads and deliverables | A supported file can be found, read with provenance, cited, and opened without forced editing/import side effects |
| Later | Expand editing, connectors, and longitudinal insight | Proven demand and explicit fidelity/recovery gates rather than another broad feature checklist |

The immediate recommendation is not to rewrite the platform. Preserve the narrative permission model, Work identity, source references, and action gates. Reduce the public promise around unfinished surfaces, repair the consequential risks, and connect the strongest existing pieces into one experience that can be trusted every morning.

## Evidence and limitations

Inspection covered critical web Files/document paths, global search, narrative ingestion/retrieval/compaction/workspace composition, Work integration, onboarding, and the connector catalog. It used the application code on `65c1ff63331a05b5e0b62a7a1d4ff25235977ffd`; the release-only differences from main v0.14.5 are version metadata. Older plans were treated as intent, not proof of implementation.

Validation: 73 tests passed across `cloud-files-services`, `documents-services`, `files-editor-contract`, `global-search`, `narrative-context`, and `narrative-compaction`. The additional Google Doc reproduction mocked both access lookup and fetch, used synthetic content, and inspected generated requests. No signed-in production UI, live provider edits, native builds, adoption metrics, or full security audit were performed. Findings distinguish code-level behavior, static risks, and product recommendations. No application code, feature flags, source settings, or deployments changed during this review.

## Sources

Repository links below identify implementation evidence at the inspected revision; they are not assertions that every path was exercised against a live provider. External documentation was accessed during the September 9, 2026 review.

[^1]: Albatross, [narrative context contract and retrieval](https://github.com/Lab86-io/lab86-mail/blob/65c1ff63331a05b5e0b62a7a1d4ff25235977ffd/lib/narrative/context.ts), [narrative service](https://github.com/Lab86-io/lab86-mail/blob/65c1ff63331a05b5e0b62a7a1d4ff25235977ffd/lib/narrative/service.ts).
[^2]: Albatross, [chat agent loop](https://github.com/Lab86-io/lab86-mail/blob/65c1ff63331a05b5e0b62a7a1d4ff25235977ffd/lib/ai/loop.ts), [Work planning](https://github.com/Lab86-io/lab86-mail/blob/65c1ff63331a05b5e0b62a7a1d4ff25235977ffd/lib/albatross/intent-plan.ts), [Work turn reconciliation](https://github.com/Lab86-io/lab86-mail/blob/65c1ff63331a05b5e0b62a7a1d4ff25235977ffd/lib/albatross/work-turn-reconcile.ts).
[^3]: Albatross, [compaction policy](https://github.com/Lab86-io/lab86-mail/blob/65c1ff63331a05b5e0b62a7a1d4ff25235977ffd/lib/narrative/compaction.ts), [reliability contract](https://github.com/Lab86-io/lab86-mail/blob/65c1ff63331a05b5e0b62a7a1d4ff25235977ffd/docs/narrative-spine-reliability.md).
[^4]: Albatross, [current hosted onboarding](https://github.com/Lab86-io/lab86-mail/blob/65c1ff63331a05b5e0b62a7a1d4ff25235977ffd/components/hosted/HostedOnboarding.tsx).
[^5]: Albatross, [Files surface](https://github.com/Lab86-io/lab86-mail/blob/65c1ff63331a05b5e0b62a7a1d4ff25235977ffd/components/files/FilesSurface.tsx).
[^6]: Albatross, [cloud provider browsing](https://github.com/Lab86-io/lab86-mail/blob/65c1ff63331a05b5e0b62a7a1d4ff25235977ffd/lib/files/browse.ts), [provider normalization](https://github.com/Lab86-io/lab86-mail/blob/65c1ff63331a05b5e0b62a7a1d4ff25235977ffd/lib/files/providers.ts), [file tools](https://github.com/Lab86-io/lab86-mail/blob/65c1ff63331a05b5e0b62a7a1d4ff25235977ffd/lib/tools/files.ts).
[^7]: Albatross, [global search behavior and destinations](https://github.com/Lab86-io/lab86-mail/blob/65c1ff63331a05b5e0b62a7a1d4ff25235977ffd/lib/search/global-search.ts), [search overlay queries](https://github.com/Lab86-io/lab86-mail/blob/65c1ff63331a05b5e0b62a7a1d4ff25235977ffd/components/palette/CommandPalette.tsx).
[^8]: Albatross, [upload/list API](https://github.com/Lab86-io/lab86-mail/blob/65c1ff63331a05b5e0b62a7a1d4ff25235977ffd/app/api/agent/uploads/route.ts).
[^9]: Albatross, [corpus search](https://github.com/Lab86-io/lab86-mail/blob/65c1ff63331a05b5e0b62a7a1d4ff25235977ffd/lib/tools/corpus.ts), [cloud search and Google import tools](https://github.com/Lab86-io/lab86-mail/blob/65c1ff63331a05b5e0b62a7a1d4ff25235977ffd/lib/tools/files.ts).
[^10]: Albatross, [Files implementation/research scope](https://github.com/Lab86-io/lab86-mail/blob/65c1ff63331a05b5e0b62a7a1d4ff25235977ffd/docs/research/albatross-files-research-2026-07-27.md), [partially superseded corpus plan](https://github.com/Lab86-io/lab86-mail/blob/65c1ff63331a05b5e0b62a7a1d4ff25235977ffd/docs/files-and-documents-plan.md).
[^11]: Albatross, [narrative observation mapping](https://github.com/Lab86-io/lab86-mail/blob/65c1ff63331a05b5e0b62a7a1d4ff25235977ffd/lib/narrative/observations.ts).
[^12]: Albatross, [Google import](https://github.com/Lab86-io/lab86-mail/blob/65c1ff63331a05b5e0b62a7a1d4ff25235977ffd/lib/documents/google-import.ts), [Google write-back](https://github.com/Lab86-io/lab86-mail/blob/65c1ff63331a05b5e0b62a7a1d4ff25235977ffd/lib/documents/google.ts), [editor autosave/conflict handling](https://github.com/Lab86-io/lab86-mail/blob/65c1ff63331a05b5e0b62a7a1d4ff25235977ffd/components/files/DocumentEditor.tsx).
[^13]: Google for Developers, [Google Docs API: DeleteContentRangeRequest](https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/request#DeleteContentRangeRequest).
[^14]: Albatross, [workspace identity/hydration](https://github.com/Lab86-io/lab86-mail/blob/65c1ff63331a05b5e0b62a7a1d4ff25235977ffd/lib/narrative/workspace.ts), [workspace generation/cache](https://github.com/Lab86-io/lab86-mail/blob/65c1ff63331a05b5e0b62a7a1d4ff25235977ffd/lib/narrative/workspace-service.ts).
[^15]: Albatross, [brief composition](https://github.com/Lab86-io/lab86-mail/blob/65c1ff63331a05b5e0b62a7a1d4ff25235977ffd/components/report/brief-canvas/BriefLetter.tsx).
[^16]: Albatross, [connector catalog](https://github.com/Lab86-io/lab86-mail/blob/65c1ff63331a05b5e0b62a7a1d4ff25235977ffd/lib/mcp/servers.ts).
[^17]: Granola, [Chatting with your meetings](https://docs.granola.ai/help-center/getting-more-from-your-notes/chatting-with-your-meetings), help documentation, accessed September 9, 2026.
[^18]: Notion, [Enterprise Search](https://www.notion.com/help/enterprise-search), help documentation, accessed September 9, 2026.
[^19]: Raycast, [File Search](https://manual.raycast.com/file-search), product manual, accessed September 9, 2026.
