# Albatross completion and interrupted execution dogfood

Incident analysis and implementation notes, September 14, 2026. This combines the user's Monro completion and presentation restyling reports. The fixes below are implemented on `fix/albatross-dogfood-reliability`; production and staging records have not been repaired or redeployed. The initial findings describe the incident code before these changes.

## Product expectation

An authorized request must produce a durable result that every relevant surface agrees on. If execution is interrupted, Albatross must preserve confirmed progress, establish the outcome of uncertain writes, and continue without duplicating actions. A successful tool call alone does not establish that the user's entire request is finished.

## Case 1: Monro is finished but still appears as outstanding work

The user explicitly reported that the tire repair was done. Chat attempted to record progress three times with errors, succeeded with a smaller payload, then invoked replanning. The screenshot shows both “Finished. This one is off your list.” and a plan-generation timeout after 144 seconds. The user reports continued inclusion in briefs.

Confirmed code paths:

- `lib/tools/albatross.ts`: `albatross_record_progress` writes the confirmed user statement first, then optional evidence and question answers through separate mutations. A later failure does not undo earlier successful writes. The response does not return the resulting Work lifecycle state.
- The optional evidence schema accepts only `observed` and `inferred`. The user statement is separately assigned `confirmed` by the server. The first reported validation error is consistent with this boundary; widening external evidence trust is not the remedy.
- `convex/albatrossWorkV2.ts`: `attachProof` can close Work automatically when its contract is satisfied. Explicit completion, proof-driven completion, and completion-question answers use separate transition code.
- `updateWorkState` changes Work status and records completion metrics, but does not reconcile owned tasks/projects, pending questions, or brief refresh. Its completion path does not call `scheduleNarrativeSource`.
- `lib/ai/system-prompt.ts` and `lib/albatross/work-chat-context.ts` direct progress corrections through recording followed by replanning. `albatross_replan_work` has a shape guard but no terminal lifecycle guard.
- `lib/albatross/intent-plan.ts` starts planning by writing `status: planning`; `convex/albatrossIntents.ts` can save a new plan status without guarding terminal Work state. `components/albatross/WorkDetail.tsx` renders completion from `workState`, while the area plan selection in `convex/albatross.ts` filters on `status`. These fields can disagree.
- `lib/albatross/daily-report.ts` derives active Work from queued/partially applied applications and active projects without resolving their owning Work's lifecycle. Tomorrow-plan alignment also retains completed Work rows and pending questions.
- Stored daily editions are snapshots (`lib/store/daily-reports.ts`); refetching an edition alone does not regenerate its prose.

The initial source inspection could not establish the server-error causes or stored state. Subsequent incident investigation recovered the failed payloads and read current production state; see the incident findings below. The original request-ID-specific Convex execution logs were outside the recent history returned by the CLI.

## Case 2: Presentation restyling stops with “network error”

The user requested “make these slides look beautiful.” Chat successfully opened a six-slide deck at revision 4, announced a dark-theme restyling proposal, then showed a generic network error and a Continue button. The screenshot establishes a successful read, not a successful edit or saved proposal. “Hold this” is the ordinary capture control, not evidence that the user requested a pause.

Confirmed code paths:

- `components/shell/AIBar.tsx`: Continue calls `regenerate()`. The installed SDK implementation in `node_modules/ai/src/ui/chat.ts` removes the last assistant message before submitting again. It does not resume a checkpoint containing that turn's successful tool results.
- Chat autosaves from the browser after streaming settles, with a 600 ms debounce. The save failure is swallowed. This is conversation persistence, not a durable execution record.
- `app/api/agent/route.ts` passes the request abort signal into the agent. No durable run identifier or checkpoint-resume operation is provided in this route. A disconnect must not be treated as proof that every in-flight mutation was cancelled.
- `lib/ai/loop.ts`: provider fallback is attempted only before any content is forwarded. Even an introductory text or reasoning delta commits the stream; subsequent errors are forwarded to the client. Blind replay after a mutation would be unsafe, so expanding fallback requires reconciliation first.
- The generic tool timeout uses `Promise.race`; rejecting that wait does not itself cancel the underlying operation. This is an additional recovery risk, not an established cause of this screenshot's network error.
- `lib/store/chat-sessions.ts`: compaction rewrites an interrupted non-HITL tool from `input-available` to `output-available` without requiring a result. This obscures uncertainty when restoring history. The current test explicitly expects this behavior.
- `lib/tools/documents.ts`: precise edits already support atomic operations, expected-revision protection, and explicit `applied`, `proposed`, or `conflict` results. Review proposals do not change the file. The system prompt already says explicit editing requests authorize apply mode; this request should not acquire an unnecessary approval step.

The originating network failure is unverified: provider streaming, browser transport, and server interruption cannot be distinguished from the screenshot. Subsequent incident investigation found document validation errors and checked revision history; those failures do not by themselves establish the cause of the browser's network-error label.

## Incident findings from logs and stored records

Read-only investigation on September 14 located Monro in production at approximately 10:36–10:39 AM Eastern and the deck interaction in staging at approximately 10:43–10:45 AM Eastern. The user confirmed the deck failure was around 40 minutes before the follow-up investigation. No production or staging records were modified.

### Monro: recovered inputs explain the preventable failures

- The saved chat's first failed call contains `trust: reported` on a manually supplied user-report evidence entry. The tool accepts only `observed` or `inferred` for optional evidence. The confirmed user statement was already the responsibility of the separate server-authored chat evidence entry, so the duplicate manual entry was unnecessary.
- The second and third failed calls are identical. Each includes `sourceKind: mail_thread`, omits `accountId`, and supplies a composite `mail:<account>:<thread>` reference as `sourceId`. The tool schema permits the missing account, but `attachProof` requires it. Invoking the current handler locally with the same input shape reproduces `Mail proof requires an account.` before any mail lookup. Even after supplying the account, the composite reference must be resolved into the provider thread ID.
- Railway records two handler errors at approximately 14:36:17 and 14:36:30 UTC, followed by a successful lean progress call around 14:36:40 UTC. The trust parse failure is absent from audit logs because parsing occurs before the audited handler block in `invokeTool`.
- The saved successful call has no optional evidence. It is followed by a replan whose reason explicitly says the outcome is complete. The production usage record reports `The operation was aborted due to timeout` for `albatross_plan` around 14:39:19 UTC.
- Current Work state is `workState: done`, `status: done`, `agentState: error`, with `planError: Plan generation timed out after 142s`. The two lifecycle fields are currently consistent in this incident; their potential divergence is an additional code defect, not a confirmed explanation for Monro's continued brief inclusion.

### Deck: confirmed invalid edits, transport failure still unresolved

- The saved staging chat exactly matches the supplied transcript: the successful deck read and the promised dark-theme proposal. It contains no confirmed edit result.
- At 14:44:18.761 UTC, the agent usage record reports `Invalid args for document_edit: operations.2.element.y — Too small: expected number to be >=0`.
- At 14:45:17.611 UTC, another agent usage record reports `Invalid args for document_edit: operations.5.element.height — Too small: expected number to be >=1`.
- Those calls used `z-ai/glm-5.3-flash` through OpenRouter. This identifies the execution configuration; it does not establish that changing the model alone fixes the interaction.
- The corresponding Railway proxy records show three `/api/agent` requests returning HTTP 200, lasting about 73.4, 24.6, and 55.3 seconds, with empty upstream-error fields. HTTP 200 does not prove a streaming response completed successfully. No agent transport exception appears in the bounded runtime-log window.
- Revision history shows revision 4 before the request and revision 5 from a user `inline_edit` at 14:44:49 UTC. There is no AI revision from the restyling attempts. The earlier AI revision is the original six-slide content fill, not a redesign.
- Telemetry has a diagnostic bug: `toUIMessageStream.onError` is used by the SDK for both tool errors and stream errors. `streamAgentTurn` stores only the first through `streamError = streamError ?? error`. Thus a validation error can occupy the sole usage error field and conceal a later distinct failure. Monro illustrates this: its final agent usage error is the initial trust validation failure even though later steps ran and planning subsequently timed out.

Do not relabel the deck incident as “just bad Wi-Fi” or assert that its network error was proven to be a geometry error. The geometry failures are confirmed; the transport cause remains unknown with the retained diagnostics. Repair error classification and preserve all correlated tool/stream failures so a future incident has a definitive cause.

### Prevention work to prioritize before broader recovery infrastructure

1. Make optional evidence a source-specific contract: require/resolve a mail account and provider thread ID, and avoid asking the model to restate the user's trust level. Return structured validation feedback before any partial evidence writes; suppress identical retries unless the inputs change.
2. Give the agent explicit slide-coordinate units and bounds, and return repairable field errors without ending the turn. Consider deterministic layout/style operations for common restyling so the model does not have to invent every coordinate. Preserve strict bounds instead of silently accepting corrupt geometry.
3. Skip replanning on explicit completion and reject planning writes to terminal Work. This removes the unnecessary timeout from the completion path.
4. Separate recoverable tool validation from fatal provider/transport errors. Log correlated run/step IDs, stream completion versus abort, provider request identifiers where available, and sanitized error causes. Never overwrite later failures with the first recoverable error.

Additional errors were present nearby in independent features: an area classifier sent a strict response schema missing `factIds` from `required`, and narrative workspace requests tried to disable mandatory reasoning. Track these as separate configuration/schema defects; the available evidence does not make either the cause of the deck network error.

## Proposed implementation

### Completion propagation

1. Create one idempotent completion transition used by the UI, an explicit chat completion tool, and existing automatic completion paths. Persist the statement, canonical terminal state, and completion event together. Explicit user completion must not depend on optional corroboration or an LLM replan.
2. Clear obsolete planning errors and pending work activity. Guard planning start, plan save, question writes, and action application against terminal Work state, including races with already-running operations. Only an explicit reopen may reactivate Work.
3. Reconcile generated actions owned by the finished outcome. Distinguish tasks actually completed from unnecessary remaining tasks retired because the outcome is finished. Close a project only when its ownership and scope justify it; a shared project or merely related source must not be blanket-completed. Preserve actual completion metrics.
4. Use the same lifecycle eligibility rules for active briefs, areas, questions, projects, tasks, and recommendations. Remove actionable references immediately using live state; refresh narrative and affected generated prose asynchronously. Preserve historical editions and completion history.
5. Return structured partial results for optional evidence failures. Preserve valid trust boundaries and validate source-specific requirements before attachment writes. A failed attachment must not invalidate a successful completion.
6. Repair existing terminal Work with inconsistent status fields and leftover owned actions, including Monro, after inspecting the actual records.

### Interrupted execution and truthful recovery

1. Persist an authenticated run ID and stable operation identities before execution. Record confirmed tool results and artifact/revision identifiers server-side as each step settles.
2. Model interruption and unknown outcomes explicitly. Neither a timeout nor a lost response establishes that a write failed. Never fabricate successful tool results during transcript compaction.
3. Replace regenerate-based Continue with checkpoint recovery. Reconcile uncertain writes against their operation records and current document revision/suggestions; resume only outstanding work. Add idempotency at mutation boundaries so a lost acknowledgement cannot duplicate a write or proposal.
4. Distinguish reconnecting to execution from restarting generation and from explicit cancellation. Support bounded automatic recovery for transient failures where replay is demonstrably safe. Preserve completed steps if manual recovery is required.
5. Show the last confirmed action and whether the next action is running, interrupted, failed, or of unknown outcome. Correlate browser, run, tool, and provider errors through request/run IDs without exposing raw private payloads.
6. For direct deck-edit requests, apply the authorized revision-protected edit, then reread and verify the actual slide content before claiming completion. Preserve proposal mode when the user requests a proposal.

## Acceptance cases

- Explicit “Monro is done” closes the intended Work without replanning, removes its outstanding obligations across active surfaces, and stays closed after refresh and background processing.
- Completion during an in-flight plan prevents the late result from changing lifecycle or creating new tasks/questions.
- Invalid optional evidence leaves completion successful with a specific attachment warning; repeated completion does not duplicate events.
- Shared or merely related tasks/projects remain correctly scoped; retired actions are not falsely counted as performed.
- Fresh briefs do not revive completed Work from queued applications, check-ins, old tasks, or stale narrative. Existing active recommendations reconcile immediately; historical records remain available.
- Disconnect after `document_get` resumes the edit with its confirmed read context retained.
- Disconnect after an edit commits but before its acknowledgement returns discovers the saved revision and does not apply it again. The same applies to saved proposals.
- Concurrent manual deck edits produce a revision conflict and reread, not an overwrite.
- Reloading interrupted chat preserves an unknown operation outcome until reconciliation; it never displays invented success.
- An explicit six-slide restyle produces verified edits to all six slides, without an unsolicited approval requirement.

## Validation during analysis

The existing completion/tool/daily-context/state-route suites passed: 41 tests across four files. The existing stream-helper/document-edit/session-compaction suites passed: 28 tests across three files. These are baseline results, not proof of the proposed fixes. In particular, current compaction tests encode the problematic conversion of interrupted tools to completed-looking state. New cross-surface, interruption, and lost-acknowledgement tests are required.

The initial analysis changed no UI. Implementation preserves the existing surfaces, density, and visual design; it changes eligibility and recovery behavior as described below.


## Implemented changes

- Added `albatross_complete_work`: one transaction saves the user's confirmed statement, closes Work, records the completion, clears obsolete planning errors/watch claims, supersedes pending questions, and rejects pending approvals. Every existing completion entry point shares the transition. Repeating completion also repairs leftover state without duplicating the completion event.
- Generated unfinished tasks are retired with explicit provenance, not counted as completed. A project closes only when it belongs to this Work and has no independent task or other Work links. Explicit reopening restores only artifacts retired by that completion. Related independent tasks are preserved.
- Planning saves, agent-state changes, question writes, generated task/project creation, and approval enqueue/claim reject terminal Work. The replan tool returns an immediate no-op for closed Work. Already-issued remote provider operations cannot be cancelled by a later completion.
- Current daily and area briefs resolve referenced Work/tasks against live lifecycle state, including stored editions that otherwise keep stale actionable rows. Updates invalidate that overlay; polling covers completion in another tab. Explicitly selected historical editions retain their original rows. Fresh daily composition excludes completed owners of queued applications and tomorrow-plan entries, and narrative workspace hydration drops closed Work. Generated free-text prose remains a snapshot until the next composition; it is not rewritten with string replacement.
- Mail evidence resolves `mail:<account>:<thread>` references and rejects missing/conflicting account IDs before writes. Confirmed user reports remain server-authored; arbitrary `reported` trust is not accepted. Optional source failures return saved progress plus an attachment warning.
- Added a deterministic `deck_restyle` operation for consistent colors across all slides while preserving content, geometry, existing font sizes and revision protection. Raw element tools now describe coordinate units and bounds. This is a safe theme primitive, not a full layout/design engine.
- Mutating agent calls claim an owner-scoped run/argument identity before invocation. Confirmed results are checkpointed; duplicate claims return the saved result or block execution while the outcome is uncertain. Document revision/proposal identifiers are recorded in the same transaction as the write, so a lost acknowledgement can be reconciled without a duplicate save. Other provider writes remain explicitly uncertain when no acknowledgement was recorded, and must be checked at the source before another attempt.
- Continue retains the interrupted assistant turn, retrieves server checkpoints using the original user-message ID, and resumes from that context. It does not regenerate the last assistant message. Restored unfinished tools show an unconfirmed outcome instead of invented success; HITL questions remain pending.
- Tool validation errors and fatal stream errors have separate diagnostics. Exact rejected argument repeats are suppressed within a run. Server/client logs carry a shared run ID; streams send a 15-second heartbeat and disable proxy buffering. These measures reduce idle disconnect risk and improve diagnosis; they do not establish the cause of the original network error or make network failures impossible.
- Fixed the strict classifier schema to require `factIds`, and removed unconditional reasoning-disable options from classifier/narrative requests. Account deletion includes execution checkpoints.

## Research and scope

The Mobbin skill was read before implementation. No Mobbin capability was callable in this session. The browser research tool failed because its local OpenClaw configuration file was missing. Official product documentation was used as the available fallback:

- [Linear filters](https://linear.app/docs/filters) and [display options](https://linear.app/docs/display-options): current views can exclude terminal states while keeping records available.
- [Linear custom views](https://linear.app/docs/custom-views): preserve the existing view and change eligibility rather than redesigning the surface.
- [Notion version history and restore](https://www.notion.com/help/duplicate-delete-and-restore-content): retain saved state/history as a recovery reference.

No visual redesign or Apple-platform implementation is included. Browser interaction was exercised through the installed AI SDK's real Chat class and React render tests; no live browser/provider end-to-end restyle has been claimed.

## Rollout and existing Monro cleanup

Deploy the Convex functions/schema before the web build: new web tool calls and brief eligibility queries require those functions and indexes. Reapply `albatrossWorkV2.updateWorkState` with `state: done` to the inspected Monro Work after deployment; the transition is idempotent and clears its stale error/owned activity without requiring another generated plan or adding a second completion event. Check that the Work remains done, pending questions/approvals are gone, and current daily/area views no longer offer it as outstanding.

The live deck was not restyled by this code change. After staging rollout, run the original six-slide request and verify the actual saved/proposed revision, then simulate a lost response and Continue. Generic provider operations with an unknown outcome require source reconciliation; this implementation does not claim a universal resumable job runner or automatic retry of every external write.


## Final local validation

- Full suite with coverage: 3,937 tests passed across 403 files. Execution-checkpoint coverage and all changed library files meet the release baseline. Real SDK stream tests cover recovery after invalid deck geometry, fatal interruption after partial content without replay, safe fallback before content, and cancellation before generation. Changed-file coverage meets or exceeds the CI baseline without changing its thresholds.
- TypeScript passed. Production `next build` passed, including its TypeScript and static-page stages.
- Biome passes over all tracked files plus new patch files, with one existing image-element warning. The literal `bun run lint` command is blocked by a pre-existing nested root config at `.claude/worktrees/chat-agentic-pass/biome.json`; the explicit-file run checks the actual repository without modifying that other worktree.
- Convex code generation/bundle analysis passed and generated API bindings are included. The codegen operation did not activate a deployment.
- `git diff --check` passed.

The regression coverage includes direct completion without a planner, idempotent completion metrics/evidence, late plan/error/question/approval writes, restoration after reopen, shared-project preservation, mail evidence normalization, partial attachment failure, current-versus-historical brief rendering, actual SDK continuation with the original read retained, uncertain restored history, tool-versus-stream error classification, six-slide theme preservation, concurrent tool claims, lost revision acknowledgements, and lost proposal acknowledgements.

## Release review follow-up

CodeRabbit's review of #249 arrived after the staging merge. Its verified findings were addressed for the staging-to-main release: current collections and Area board tasks exclude retired references, project references reconcile independently, timeline connectors follow visible rows, all nonterminal reopening states restore owned activity, terminal Work rejects step completion, and closed applications no longer create current review pressure. Final failed checkpoints are immutable. Oversized document reads retain a bounded successful result with reread guidance, and system recovery context contains only normalized execution metadata, never raw tool text or error bodies. Focused runtime, rendering, compaction, and source-boundary tests cover these paths.

The first full release review (#250, review 5204616716) additionally identified stable continuation identity, recovery ordering, cancellation, ownership, and editor boundaries. Message IDs with punctuation now map deterministically to a safe run ID; continuation without the original identity is rejected. Recovery selects newest checkpoints and packs complete metadata records within the budget. Cancellation emits an abort. Work references must resolve to owned open records, terminal evidence writes are rejected, terminal title edits remain possible, and reopening clears release metadata. Word coordination refreshes its prepared deadline, header/footer edits reuse existing parts, and formatting inserts properties in canonical order. Spreadsheet batches can update a preceding CREATE_SHEET result; image reads accept bounded supported embedded data only, and oversized generated workbooks return 413. The mobile filename control retains a readable focus size.

Word property ordering was checked against Microsoft's [Open XML SDK schema metadata](https://github.com/dotnet/Open-XML-SDK/blob/main/generated/DocumentFormat.OpenXml/DocumentFormat.OpenXml.Generator/DocumentFormat.OpenXml.Generator.OpenXmlGenerator/schemas_openxmlformats_org_wordprocessingml_2006_main.g.cs). Regression tests inspect the package XML and verify repeated header/footer replacement does not retain stale note content or add package parts.

The second completed release review (5204686482, on intermediate staging commit d159591) is addressed as well: approval-only Work references participate in terminal-state filtering; retired cards and their explicit Area links no longer count as active tasks; mixed-source narrative threads retain their live Work; edition changes remount the brief's local overlays; and fully filtered sections leave no empty shell. Checkpoint reads paginate, including regression coverage beyond 100 executions. Every oversized successful tool output retains a valid omission marker.

Spreadsheet commands now execute in an isolated Node worker process with a 15-second overall deadline and a 256 MB V8 heap limit. Input validation happens before process creation; errors and timeouts discard the candidate. Real-engine tests verify ordering, persisted features, atomic rejection, event-loop responsiveness, and forced termination. Native canvas bindings crashed Bun's in-process worker/coverage runtime during validation, so process isolation is used for both production and tests. The browser and worker share the same legacy-grid converter. Catalog generation uses the pinned upstream compiler options, resolves installed dependencies, and rejects TypeScript diagnostics before producing contracts.

Word edits read callback state only after React commits, tool results retain the Word document kind, and the preview honors direct Office links and cancels stale fixture timers. Browser acceptance passed for direct opening, rename, AI save/pause/reopen, failed-save draft retention, copying an existing document, and 798/390-pixel layouts. These checks use the documented synthetic Collabora transport; they do not claim a live Collabora end-to-end test.

An additional automatic review of 7add9ab (5204728927) caught Word section scope and remaining XML property containers. Header/footer edits now cover every live section and existing page variant; package tests verify old header/footer content disappears without adding parts. Section/table/row/cell property insertion uses the same schema-aware ordering, including header/footer references. The third review completed even though a separate manual follow-up command was rate-limited.
