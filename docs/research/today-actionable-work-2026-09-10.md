# Today: work you can act on

Product direction and implementation record for the September 10 local review.
The response-to-agent path below is implemented. The richer artifact bodies,
metric charts, and unattended background execution later in this document remain
proposed work. Staging has not been pushed.

## Implemented: respond to a recommendation and continue in the main agent

The SBAR handoff was not removed: `lib/brief/triage-index.ts` and
`lib/mail/daily-brief-handoff.ts` still build and preserve the canonical legacy
report handoffs. See `docs/daily-brief-handoff-research.md`. The newer narrative
working surface had no response-to-agent connection. It now has **Respond & act**:
one short instruction hands the recommendation to the existing shared chat and
20-step agent loop. It does not run a second agent or embed another conversation
inside the brief.

`lib/brief/response-context.ts` rehydrates the authenticated user's current
workspace using its timestamp, revision stamp, thread identity, and the exact
recommendation answered. A hidden/deleted source, stale stamp, or replacement
recommendation stops the action rather than silently answering different advice.
The existing title, source trail, summary, and next step become SBAR reference
data; source text is explicitly quoted and does not supply authorization.
A matching owned Albatross attaches its live plan and shape and uses the existing
post-turn reconciliation to record the actual results back to that Work.
The legacy report handoff index and its existing direct actions remain intact.

The user's response goes through the ordinary agent transport, tools, progress
UI, chat history and error handling. A separate transient request channel leaves
the existing composer text and file attachments untouched, waits for an active
turn to finish, and claims each response once. A queued response can be cancelled.
If a different Work/Area chat is active, its finished turn is saved before the
brief continues in a global conversation. The attached brief remains visible and can be detached; starting or loading a
chat clears this transient attachment. It is not persisted as a global preference.

Agent guidance asks for actual editable drafts, documents, sheets, presentations,
calendar results and Tool UI output, with a plan for multi-step work. Explicit
creation/tracking requests can create Albatrosses. Existing lists, practices and
monitors no longer show a misleading generic completion button. Their stored
shape is included in both the Today projection and server-resolved Work context.

Google Meet was the missing calendar capability. `calendar_create_event` now
accepts `conferencing: "google_meet"`, validates a connected Google account, asks
Nylas to auto-create the conference, and returns the provider's actual URL.
Attendees use the existing provider invitation path and require user authorization;
an explicit request to invite counts. A created event awaiting its conference
returns a pending flag rather than a fabricated link or another creation attempt.
Sources: [Nylas conferencing](https://developer.nylas.com/docs/v3/calendar/add-conferencing/)
and [event creation reference](https://developer.nylas.com/docs/reference/api/events/create-event/).

This is user-directed execution, bounded by the existing request/step budget.
It does not add an unattended runner, standing permission system, real coding
agent launcher, or automatic external distribution of prepared drafts. A coding
handoff can be prepared as an editable document, with context and acceptance
checks. Rich, durable artifact bodies on Today itself remain the next layer.

## Direction

Today should bring the next useful result to the person: a reply to review, a
document to improve, a choice to make, a number to log, or a change worth seeing.
Every card should answer three questions: what changed, what is ready, and what
can I do here? More ways to act should come from the artifact itself and its
current state. A permanent row of eight generic buttons would make the surface
harder to use.

Keep one calm frame with a short serif title, one line explaining why it matters,
and a useful body. Give the body the most space. Use the common corners, content
fill, compact spacing, and neutral controls. Reserve accent color for the next
action and a small status. Sources become a compact, expandable citation row;
retain dates, provenance, and the distinction between reported and observed facts.
Avoid repeating the same fact in summary, source excerpt, next step, and suggestion.

Each card gets one primary action, up to two relevant secondary actions, and a
quiet menu for defer, dismiss, correction, history, and alternate output formats.
Show completed actions as concise receipts. A failed action keeps the draft and
offers a retry. A blocked action asks the specific missing question in place.

Example: **“Reply to Maya about the launch schedule”** becomes
**“Your reply to Maya is ready”** only after a durable draft exists. The card shows
the real recipients, subject, and editable text. Its actions are **Send reply**,
**Edit**, and **Add attachment**. Source links remain below. An unanswered question
about the photography date belongs above the draft as a small choice control.
Opening the full mail editor or the shared chat is optional.

## What the code already has—and what Today is missing

- `lib/narrative/workspace.ts` currently permits title, summary, source aliases,
  and next-step prose. `WorkspaceWork` now contains id, title, state, guided, shape, and
  nextStep. It still carries no metric series, milestones, artifact revisions,
  or action capabilities. This explains the repeated generic cards.
- `lib/narrative/workspace-service.ts` hydrates matching live work by owned work
  identity, independently of model prose. Keep that boundary. The composition
  prompt expressly describes suggestions and does not execute tools.
- `lib/albatross/work-shape.ts` and `shape-policy.ts` define seven shapes with
  different planning, completion, and monitoring rules. Today should use those
  rules and the live work detail projection, not infer a new shape from its title.
- `components/albatross/shapes` already provides list, milestone, metric/practice,
  and artifact-log UI. Reuse compact adapters so Today and Work detail agree.
- Tool UI is already vendored: MessageDraft, Plan, ProgressTracker, OptionList,
  QuestionFlow, Chart, StatsDisplay, DataTable, CodeBlock, CodeDiff, and receipts.
  The local Chart has data-point callbacks. Visuals still need real data binding
  and application handlers; rendering a component does not implement an action.
- Existing tools save mail drafts and create editable `doc`, `sheet`, and `deck`
  documents. Document creation supports source context and references, and records
  undo information. The shared chat can already display tool results and work
  with the open file. Today does not yet persist and present these artifacts in
  its working cards.
- Routine consent and run eligibility already exist. The inspected tool registry
  has connected-item search and task creation, but does not supply a complete
  coding-agent session launcher with run status, cancellation, and PR receipts.

## Shape decides the body; artifact decides the immediate action

These are separate dimensions. A project can contain an email draft, spreadsheet,
and coding handoff. “Email” should not become a new Albatross shape.

| Existing shape | Useful compact body | Actions in Today | Appropriate visualization |
| --- | --- | --- | --- |
| Quick | The next step and its prepared output | Review/send a reply, edit a draft, do the step, record the result | Small step indicator only when multiple real steps exist |
| Project | Current milestone, blocker, latest deliverable | Review artifact, draft the next deliverable, change a milestone, request an update | Existing milestone rail; dependency view when dependencies are known |
| Decision | Options, criteria, sources, explicit unknowns | Compare, adjust criteria, ask for evidence, choose | DataTable/OptionList; comparison bars for supported numeric values |
| Practice | Latest logged value and recent history | Log a value, correct an entry, adjust a target | Chart or StatsDisplay with units, dates, missing-data gaps, and target context |
| Monitor | What changed since the previous observation | Inspect the change, change a threshold, prepare a response, pause monitoring | Time series or before/after diff; a visible threshold when supported |
| Recurring | This occurrence, its output, and next run | Review this run, run now, skip once, change schedule | Run history and next-run label; a chart only if there is a measured trend |
| List | A few relevant saved items or a suggested addition | Add, edit, reorder, compare, open the original | List, carousel, or comparison table; no artificial completion meter |

For a source thread without a matching Albatross, offer an appropriate preparation
action such as **Draft a reply** or **Prepare a comparison**. It can produce a
reviewable artifact without forcing the person to create a task first. **Track
this as an Albatross** remains available if it becomes ongoing work. A draft is
not an implicit commitment or evidence that the underlying work is finished.

## Make charts and tools functional

Start with the user's next decision, then choose the visualization. A chart should
allow inspecting the observation behind a point; a table can select an option;
a milestone can open its deliverable. A dependency graph is useful for answering
“what is blocking this?” with a node that opens the blocking work. Most quick
email actions need no chart.

Every metric needs a source, unit, observation time, and freshness. Label estimated
values, retain gaps, and never manufacture completion percentages or confidence
scores from prose. Provide accessible data rows and keyboard actions alongside
chart interactions. Persist a changed target through the real metric mutation;
do not let a slider merely animate a chart.

Use Tool UI as a shared component registry. Bind its callbacks to the same command
handlers as Work detail and Chat. A user changing an artifact in one surface must
see that revision in the other. The generative layer chooses supported block
types and content; the application resolves owned records, computes capabilities,
validates arguments, and performs mutations.

## How far automatic preparation should go

My recommended default is **prepare the next useful result on work the person has
entrusted to Albatross**. It should gather context, resolve known dependencies,
draft, check its own work, and leave a ready artifact. Do not make the person
approve every research or drafting step. Passive mention in an email alone should
not launch a project or create a pile of files.

For ongoing work, allow per-work instructions such as “keep the weekly report
ready” or “prepare replies, but I send them.” For explicitly delegated execution,
continue within that scope until the requested outcome or a real blocker is
reached. Reuse standing permissions rather than asking repeatedly. Sending,
publishing, booking, merging, and other external commitments use the authority
already granted to that work; when it is absent, the ready artifact is the point
to request it. These are product defaults to design, not a new permission flow
for this coding task.

| Output | Albatross can prepare | What the person sees | Further execution |
| --- | --- | --- | --- |
| Email | Read the thread, identify recipients, draft the reply, assemble approved attachments | Inline MessageDraft with source thread and editable fields | Send using existing mail semantics and a delivery receipt; sending failures preserve the draft |
| Document | Research, outline, draft sections, cite sources, check missing facts | Actual editable document, revision, and compact preview | Continue in the existing editor; export or publish when requested |
| Spreadsheet | Build a sourced comparison, model calculations, check totals | Small table/chart with a link to the full sheet | Edit assumptions, recompute, export; distinguish formulas from observed values |
| Presentation | Build the story, draft slide content, check coverage and sources | Slide preview and outline linked to a real `deck` document | Edit, regenerate selected slides, export or publish |
| Coding task | Inspect connected issue context and prepare a bounded implementation prompt | Editable CodeBlock/file with scope, acceptance criteria, and relevant links | Copy/export first; a connected coding runner can later return status, diff, checks, and PR |

A coding handoff should include the objective, repository/branch if known,
reproduction, expected behavior, constraints, likely relevant paths, acceptance
criteria, test commands, deliverables, and unresolved questions. Unknown paths
stay unknown until a repository can be inspected. A handoff is not evidence that
an agent has run. Execution needs an explicit adapter with repository access,
session identity, follow-up, cancellation, and a durable result.

Background work needs bounded runs, deduplication, and visible stop conditions.
Key preparation to the work, source revision, action kind, and artifact revision
so refreshes cannot create duplicate drafts. Reuse or update the previous draft
until the person edits it; then merge or offer a revision rather than overwriting.
Stop on paused/released work, changed scope, unavailable credentials, a real
question, or a budget boundary. Surface “Draft ready,” “Needs your choice,” or
“Source changed,” with access to details. Avoid indefinite “working” states.

## Implementation sequence

1. **One truthful card contract.** Hydrate shape, execution state, artifact
   references/revisions, freshness, and permitted actions from live work. Keep
   source-only suggestions usable. Extract compact adapters from existing shape
   components; do not fork state machines.
2. **Email and document preparation end to end.** A preparation command owns the
   run and persists its artifact reference. Today renders it inline, edit uses
   the existing editor, and completion comes from an actual result. Preserve
   drafts across navigation and failures.
3. **Shape-specific interaction.** Add list editing, metric logging, milestone
   actions, decision choices, and run controls using their current mutations.
   Add charts where their data is already available. This removes the current
   generic “Mark work done” affordance from shapes with no finish line.
4. **Proactive preparation.** Schedule bounded preparation for opted-in work and
   routines; expose pause, freshness, budget, and revision history. Test retries,
   duplicate runs, stale sources, user-edited drafts, and cross-account isolation.
5. **Coding handoff and connected execution.** Start with high-quality portable
   prompts, then add a runner behind the same work/run/artifact contract. Display
   actual diffs and checks when they exist.

The first convincing slice should be a real inline reply and a real document
draft produced from the same Albatross. That proves the path from context to
preparation to review to result, before widening the set of visualizations.

## Research

Mobbin search/flow tools remain unavailable in this session. Inspected the actual
local Today, Work shape, document, chat, and Tool UI implementations. No Mobbin
screens or findings are claimed.

[Tool UI Message Draft](https://www.tool-ui.com/docs/message-draft) demonstrates
an artifact with its review actions and a compact resulting receipt. We should
adapt that composition to our existing mail behavior.
[Tool UI Chart](https://www.tool-ui.com/docs/chart) documents typed series and
data-point interaction; the local implementation supports that direction.
[Tool UI Plan](https://www.tool-ui.com/docs/plan) provides an existing plan
surface to reuse where planning belongs to the shape.

[Linear coding sessions](https://linear.app/docs/coding-sessions) put the coding
result, diff, and verification alongside the delegated issue. The applicable
pattern is continuity from work context through execution and review.
[Linear delegation](https://linear.app/docs/assigning-issues) keeps the human
owner associated with delegated work.
[Notion Agent](https://www.notion.com/en-gb/help/notion-agent) illustrates one
assistant operating on existing workspace artifacts. Our proposed adaptation is
to retain the shared chat and artifact owners while making their useful results
available directly in Today.
