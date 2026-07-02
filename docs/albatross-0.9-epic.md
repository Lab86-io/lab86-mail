# Albatross 0.9 Epic

Date: 2026-06-30
Status: Draft for issue creation
Target: 0.9.0 Lab86 Mail expansion / private-use release

## Product Thesis

Albatross is the verified intent layer inside Lab86 Mail 0.9. It expands the
current Mail + Calendar + Tasks product; it does not start a separate app
architecture.

Future Lab86 products such as Terminal, Files, and Music should be able to plug
into this layer later, but 0.9 is built in this repo and on top of the existing
Lab86 Mail surfaces, tools, operation log, and data model.

The product does not guess a user's life from artifacts. It asks, remembers,
verifies, and acts.

The core bet:

> Context should reduce questions, not replace intent.

Albatross wins if a user can wake up anxious about something they have avoided,
say it out loud, answer a few targeted questions, and get a realistic plan that
creates the right tasks, calendar events, instructions, and follow-ups without
making inaccurate digital junk.

The first target user is Jakob. Optimize 0.9.0 for real daily use over one week.
Public positioning can wait until the loop proves itself.

## Product Promise

Primary sentence:

> I dumped my brain into it, and it turned my week into a plan.

More precise daily-use version:

> I woke up in terror about something I was procrastinating on, put it down, and
> Albatross made a realistic plan and put time on my calendar to handle it.

Important nuance:

- Not every interaction is a brain dump.
- Some interactions are small refinements.
- Some interactions are context corrections.
- Some interactions are replans after the day changes.
- Some interactions are "what is this thing and where does it belong?"

## Naming

Working feature/product layer name: Albatross by Lab86.

Possible architecture:

- Lab86 Mail 0.9 remains the product being expanded.
- Albatross is the intent/context/planning layer within Lab86 Mail.
- Future Lab86 suite products can add their own artifacts and tools to the same
  area/intent/plan graph later.
- Do not use the 0.9 work to introduce a new standalone architecture.

## Non-Negotiables

1. Better to ask than be wrong.
2. Nothing becomes permanent memory unless the user confirms it.
3. Artifacts are evidence, not intent.
4. Loud does not mean important.
5. User-declared intent outranks inferred context.
6. Raw user dumps are always preserved.
7. Inferred people, companies, relationships, locations, jobs, finance, health,
   and area membership remain candidates until verified.
8. Anything involving another human requires explicit human approval.
9. Undo does not delete context. Undone actions return to the artifact/plan as
   unresolved or blocked.
10. The system must be able to replan around real life changing.

## Inspiration And Competitive Research Instructions

Use these products constantly as UI/UX and product research inputs. Do not copy
their UI directly. Compare behavior and failure modes.

The products below are examples, not a closed list. Every major issue should
include fresh research using Mobbin, Browserbase, web search, screenshots, and
direct product inspection where possible. Find newer, better, and weirder
examples as the market changes, especially for animation, voice UI, progress
celebration, approval flows, and dense operational panes.

Primary competitors and references:

- Motion: automatic planning, calendar/task scheduling, AI project planning.
- Reclaim: calendar automation, habits, focus time, meeting/task conflict
  handling.
- Sunsama: intentional daily planning, realistic workload, ritualized review.
- Akiflow: command capture, tasks plus time blocking.
- Amie: friendly calendar/task drag scheduling.
- Dia: beautiful artifact synthesis, daily reports, and the failure mode of
  replacing intent with context.
- Notion Mail: AI mail views, labels, hover actions, inbox category UX.
- Shortwave: AI inbox, todos, summaries, semantic search.
- Fabric: personal AI workspace, broad capture/search/memory.
- Tiimo, Finch, Me+: voice/capture, gentle planning, habit/routine onboarding.
- Linear, Plane, Jira: project/issue panes, metadata rails, activity, linked
  work items.
- Lab86 Voice (`/home/jjalangtry/repos/lab86-voice`, production at
  `voice.lab86.io`): voice-agent rendering, voice-to-intent patterns,
  picture-in-picture, transcript handling, and interaction model inspiration.
  Research and reuse ideas/libraries/patterns; do not blindly move the code.

Research protocol for UI work:

1. Use Mobbin before building a new screen or interaction pattern.
2. Save 3 to 8 relevant references per major surface.
3. Identify what each reference does well, where Albatross must differ, and
   what fresh references beyond the named examples show.
4. Prefer dense operational layouts for work surfaces.
5. Allow playfulness in capture, progress, celebration, and empty states.
6. Do not let decorative UI interfere with fast scanning, corrections, or
   approvals.

Research protocol for real-life action:

1. Use Browserbase/web research for real-world tasks such as passports,
   licenses, taxes, concerts, appointments, and official requirements.
2. Prefer official sources first.
3. Store source refs on the plan.
4. Ask the user which route applies when requirements branch.
5. Never silently assume location, eligibility, progress, or document status.
6. Use Browserbase as much as possible for research, guided action, and action
   preparation, while keeping real-world or human-facing execution behind user
   approval.

Questioning protocol:

1. Search artifacts first when useful.
2. Ask before promoting any candidate fact into permanent context.
3. Ask before assigning people or organizations to areas.
4. Ask when intent conflicts with artifact evidence.
5. Ask when area loudness conflicts with today's stated priorities.
6. Ask when a plan might create inaccurate artifacts.
7. Ask when a human-facing action is ready to send/apply.
8. Over time, ask fewer annoying questions and more important questions, based
   on verified area context.

## Dia Failure Mode To Avoid

Dia's "Between the Lines" style report is beautiful, but it demonstrates the
core failure Albatross must avoid. It saw a loud CardHunt artifact stream and
treated that as the user's current life priority. It did not ask what mattered
today, did not understand multi-account context, did not know the user's active
areas, and produced a polished artifact that was useless because it replaced
intent with context.

Albatross must not make that mistake.

The report generator, intent planner, and area classifier must all treat
artifacts as evidence. If an area is loud but not clearly important today, ask.
If a person appears repeatedly but is not verified as part of an area, ask. If
recent evidence conflicts with stored area context, ask and show provenance.

## New Intent Button Shape

The New Intent control is the emotional front door of 0.9.

Desired behavior:

- Big, fun, transparent, and alive.
- Jiggly or hand-drawn animated border.
- Hover expands into a random organic shape.
- Background can feel like a painting easel or animated paper/paint wash.
- Visible copy can rotate through phrases such as:
  - New Intent
  - New Idea
  - New Procrastination
  - Make This Real
  - Unload Thought
- The accessible label and hit target remain stable.
- The button can be playful before capture, but the post-capture Intent Pane
  must become calm, structured, and operational.

Research motion/animation references deeply before implementation. Use Mobbin,
public product sites, animation libraries, and Lab86 Voice UI patterns.

## Core Concepts

### Area

A durable part of the user's life.

Examples:

- CardHunt (job)
- StatPearls (job)
- My Apps
- Money Management
- Trip Management
- Relationship Management
- Schedule Management
- AI Development News
- Music To Learn
- Habits

Areas include jobs, contract roles, club positions, committees, volunteer roles,
long-running responsibilities, hobbies, relationships, and administrative parts
of life. CardHunt and StatPearls are examples of jobs, not generic topics.

An area can own or be linked to:

- mail accounts and individual email threads/messages
- calendars and individual calendar events
- task boards and task cards
- MCP connections and external work items
- people, domains, websites, repos, locations, files, and source documents

### Area Fact

A verified or candidate fact about an area.

Examples:

- Andrew Rodrigues is Jakob's boss at CardHunt.
- Michael is a CardHunt coworker.
- A domain belongs to StatPearls.
- A GitHub repo belongs to My Apps.
- A website is relevant to Passport/Life Admin.

Facts have status:

- candidate: inferred from artifacts, not trusted.
- verified: user confirmed it.
- rejected: user said it is wrong/noise.
- superseded: it used to be true but was replaced.

Confirmed facts must have confirmation references. The user must be able to ask:

> Where the fuck did you get that from?

And Albatross must answer with the source:

- user confirmation event
- original user text/voice transcript
- email/thread/event/task/MCP artifact
- date confirmed
- date last seen
- any later contradiction

The user must then be able to mark the fact wrong, stale, rejected, or
superseded.

### Intent

A raw user-declared desire, pressure, obligation, idea, or avoidance.

Examples:

- "Fuck, I need to file my taxes by April 15."
- "Damn, I have been meaning to get this passport thing done."
- "I started a new job at CardHunt. My manager is Andrew and my coworker is
  Michael."
- "I want to learn these songs on banjo."

An intent can become:

- a task
- a project
- multiple tasks
- a calendar event
- an email/draft
- a reminder
- a web research plan
- a question loop
- nothing yet, just saved context

### Intent Plan

Every intent gets an intent plan.

The plan is generated from the initial intent, artifact search, and question
loop. It is the object that explains what Albatross intends to create or do.

An intent plan can say:

- I will create these tasks.
- These tasks happen at these locations.
- I will create these calendar events.
- I will draft this email to this person.
- I could create this project to organize the work.
- I need clarity on these questions before applying the plan.
- Here are the source references and assumptions.

Plans can create:

- task cards
- projects
- calendar events
- email drafts
- approval cards
- physical-action checklists
- source-linked instructions

Plans may be draft, needs-answers, ready, applied, superseded, or completed.
They should always be inspectable from the intent.

### Area Artifact Assignment

Emails, calendars, tasks, task boards, events, MCP items, files, and websites can
be assigned to areas.

Assignments should eventually have pretty rendering:

- area chips on mail rows and thread panes
- area chips on calendar events
- area/project/sprint metadata on task cards
- area profiles showing linked artifacts
- source/reference popovers explaining why an artifact belongs there

0.9 can prioritize correctness and correction flows before visual polish, but
the data model must support attractive rendering later.

### Project / Epic

A multi-step outcome that can be chipped away over time.

Projects are created when an intent is clearly too large for one task. Ask when
not obvious.

### Sprint

A time period for active focus. Weekly/monthly/custom details can evolve later.

The first monthly planning prompt should appear in the first Daily Report opened
after a new month.

### Unassigned

The context-review surface for things Albatross notices but does not understand.

Unassigned is not a trash pile. It is how the app learns without hallucinating.

Examples:

- "I keep seeing this banjo course sender. What is this?"
- "I do not recognize this rewards sender. Is it part of anything?"
- "This recruiter email looks fishy and I cannot place it."

## High-Level Architecture

0.9.0 should be additive and feature-flagged. Do not destabilize Mail, Calendar,
Tasks, or Daily Report.

Feature flag:

- LAB86_ENABLE_ALBATROSS

Recommended new backend layer:

- Convex tables for first-class areas, facts, artifact assignments, intents,
  intent plans, completion events, approvals, and review items.
- Projects and sprints are important, but lower priority than areas, intents,
  plans, and trust. Add them when the plan loop is working.
- Existing userDocs may be used for drafts or migration buffers, but the context
  graph should become first-class quickly.

Existing systems to reuse:

- Tool registry for all mutations.
- AI operation log and undo batches.
- Suggestion tray patterns.
- Task provenance.
- Calendar event creation/update.
- MCP item indexing.
- Daily Report rendering and service aggregation.
- AI ask_user flow.

## Data Model Draft

### areas

- userId
- name
- kind: job | contract | club | committee | volunteer | work | personal |
  admin | relationship | learning | idea | habit | other
- description
- status: active | paused | archived
- color
- icon
- planningEnabled
- dailyBriefEnabled
- createdBy: user | ai
- createdAt
- updatedAt
- archivedAt

### areaFacts

- userId
- areaId
- kind: person | domain | email | website | repo | mcp_connection |
  calendar | location | keyword | relationship | organization | rule | note
- value
- label
- role
- status: candidate | verified | rejected | superseded
- confidence
- sourceRefs
- confirmationRefs
- reason
- firstSeenAt
- lastSeenAt
- confirmedAt
- rejectedAt
- supersededAt

### areaArtifactLinks

- userId
- areaId
- artifactKind: email_account | thread | message | calendar | calendar_event |
  task_board | task_card | mcp_connection | mcp_item | url | file | contact
- artifactId
- accountId
- connectionId
- assignment: primary | secondary
- status: candidate | verified | rejected
- reason
- sourceRefs
- createdAt
- updatedAt

### intents

- userId
- rawText
- transcript
- captureMode: text | voice | import | daily_report | chat
- title
- status: captured | questioning | planned | applied | paused | done |
  archived
- areaId
- projectId
- sprintId
- classification: task | project | idea | obligation | errand | habit |
  relationship | unknown
- urgency
- importance
- sourceRefs
- createdAt
- updatedAt

### intentPlans

- userId
- intentId
- status: draft | needs_answers | ready | applied | superseded | completed
- outcome
- digitalActions
- physicalActions
- questions
- assumptions
- proposedTasks
- proposedCalendarEvents
- proposedDrafts
- proposedProject
- proposedApprovals
- sourceRefs
- appliedOperationBatchIds
- createdAt
- updatedAt

### projects

- userId
- areaId
- title
- outcome
- status: active | paused | done | archived
- horizon: week | month | quarter | long | unknown
- sourceIntentId
- createdAt
- updatedAt
- archivedAt

### sprints

- userId
- title
- type: week | month | custom
- startAt
- endAt
- status: planned | active | closed | archived
- goals
- review
- createdAt
- updatedAt

### contextReviewItems

- userId
- kind: area_fact | area_assignment | unknown_sender | unknown_domain |
  loud_area | contradiction | possible_project
- status: pending | resolved | dismissed
- title
- prompt
- candidates
- sourceRefs
- createdAt
- resolvedAt

### approvals

May reuse suggestions/operations initially, but human-facing actions need a
universal approval surface.

- userId
- areaId
- intentId
- projectId
- actionKind: send_email | invite | rsvp | book | buy | delete |
  external_write
- title
- preview
- status: pending | approved | rejected | undone | expired
- undoUntil (default human-facing undo window: 10 seconds when supported)
- sourceRefs
- operationId

### completionEvents

Task and plan completion must be stored as event history, not only current card
state, so reports can show whether the app is actually helping.

- userId
- areaId
- intentId
- projectId
- sprintId
- artifactKind: task_card | intent | intent_plan | project | calendar_event
- artifactId
- completedAt
- dueAt
- scheduledAt
- completedEarlyByMs
- completedLateByMs
- sourceRefs
- celebrationShownAt
- createdAt

## 0.9.0 Success Criteria

0.9.0 succeeds if Jakob uses Albatross for seven days and feels a real
improvement.

Minimum proof:

1. Jakob seeds real areas.
2. Albatross captures at least 10 real intents.
3. Albatross asks clarifying questions instead of guessing.
4. Every captured intent gets an intent plan.
5. At least 3 intent plans become useful task/calendar/draft/project plans.
6. At least 1 plan creates an email draft.
7. At least 1 real-life task uses Browserbase/web research with source refs.
8. At least 1 "I woke up late / I am off track" replan works.
9. Unassigned improves area context without false permanent memory.
10. Daily Report uses areas without overfitting to the loudest artifact stream.
11. Progress/completion data shows what got done.
12. No inaccurate permanent people/company/relationship facts are silently
   created.
13. No artifact spam makes the app feel unusable.

## Release Phases

### Phase 0: Guardrails And Research

- Feature flag.
- Documentation.
- GitHub epic/issues.
- Research references for first surfaces.
- Test strategy.

### Phase 1: Context Graph

- Areas.
- Area facts.
- Artifact links.
- Candidate/verified/rejected/superseded state.
- Unassigned review queue.

### Phase 2: Area Setup And Classification

- Manual area setup.
- Candidate extraction from mail/calendar/tasks/MCP.
- Area assignment for artifacts.
- Correction loop.
- Put area navigation above smart categories.
- Keep smart categories available as secondary lenses while area efficacy is
  proven.
- Slowly phase smart categories down only after area-based organization is
  clearly better.

### Phase 3: Intent Capture

- New Intent floating button.
- Voice/text capture.
- Raw dump preservation.
- Intent parser/classifier.
- Initial question loop.
- Search artifacts before asking follow-up questions.

### Phase 4: Intent Pane And Plan Generation

- Outcome.
- Digital actions.
- Physical actions.
- Questions.
- Evidence/source refs.
- Proposed tasks/events/drafts/projects.
- Apply plan through existing tools.

### Phase 5: Projects, Sprints, Replan

- Project pane.
- Task board tabs/filters for area/project/sprint.
- Monthly Daily Report ritual, initially gentle and not aggressive.
- Salvage Today / Replan flow.
- Celebration/progress reports.

## GitHub Epic

### Epic: Albatross 0.9 - Verified Intent Layer

Labels:

- epic
- albatross
- 0.9.0
- product
- ai

Body:

Albatross 0.9 introduces a verified intent and area layer inside Lab86 Mail,
above the current Mail, Calendar, Tasks, MCP items, and future connected
artifact sources.

The goal is not another AI productivity app. The goal is a trustworthy personal
context graph that captures declared intent, verifies permanent context, asks
targeted questions, and turns mandatory intent plans into executable tasks,
calendar events, email drafts, projects, and real-world instructions.

Non-negotiables:

- Context reduces questions; it does not replace intent.
- Nothing becomes permanent memory unless confirmed by the user.
- Better to ask than be wrong.
- Loud artifact streams do not automatically become today's priority.
- Human-facing actions require approval.
- Undo returns work to the relevant artifact/plan.
- The app must replan around real life changing.

Definition of done:

- Areas can be seeded and reviewed.
- Candidate facts can be verified/rejected/superseded.
- Unassigned gives the user a daily way to improve context.
- New Intent captures text/voice and preserves raw input.
- Intent planning searches artifacts first, asks questions, and creates a
  grounded plan for every intent.
- Plans can create tasks/events/drafts/projects through existing tool/operation
  paths.
- Daily Report uses area context and asks when loudness conflicts with stated
  priorities.
- The release survives seven days of real use by Jakob without artifact spam.

## Issue Backlog

Backlog-wide research rule:

Product names in individual issues are starting references, not prescriptions.
Before implementation, each issue owner should use Mobbin, Browserbase, current
web/product research, screenshots, and direct inspection to find stronger and
fresher examples beyond the named products. The implementation should cite what
was learned and why Albatross differs.

### Issue 1: Add Albatross feature flag and navigation shell

Labels: albatross, 0.9.0, frontend, foundation

Goal:

Introduce Albatross behind a feature flag without changing default Mail,
Calendar, Tasks, or Daily Report behavior.

Scope:

- Add LAB86_ENABLE_ALBATROSS.
- Add guarded PrimaryView values for areas/intents if needed.
- Add hidden route/surface skeletons for Areas, Intents, and Unassigned.
- Keep existing AppShell behavior unchanged when disabled.

Acceptance criteria:

- With flag off, app behavior and navigation are unchanged.
- With flag on, Albatross surfaces can be reached internally.
- No existing persisted client-state migration breaks.
- Typecheck passes.

Research/UX notes:

- Reference Motion/Amie for task-calendar density inspiration, then research
  beyond those examples with Mobbin and live web/product inspection.
- Reference Notion Mail/Shortwave for left-rail information architecture, then
  research beyond those examples.
- Keep the shell operational, not a marketing page.

### Issue 2: Implement first-class Area and Area Fact schema

Labels: albatross, 0.9.0, backend, context-graph

Goal:

Create the verified context graph foundation.

Scope:

- Add areas table.
- Add areaFacts table.
- Add areaArtifactLinks table.
- Add indexes for user, area, status, kind, artifact lookup.
- Add Convex queries/mutations for CRUD and status transitions.
- Add sourceRefs shape.
- Add confirmationRefs shape so verified facts can answer "where did you get
  that from?"

Acceptance criteria:

- User can create/archive areas.
- User can add candidate and verified facts.
- Candidate facts cannot be treated as verified.
- Facts can be rejected and superseded.
- Verified facts expose queryable confirmation/source refs.
- All writes are user-scoped.
- Tests cover transitions: candidate -> verified, candidate -> rejected,
  verified -> superseded.

Guardrails:

- Any fact that becomes permanent area context must be explicitly confirmed.
- People, job, relationship, location, finance, health, and organization facts
  must never be auto-verified.

### Issue 3: Build Area Setup flow

Labels: albatross, 0.9.0, onboarding, frontend

Goal:

Let Jakob seed real areas manually so the system starts with trustworthy context.

Scope:

- Add "Teach me your life" setup flow.
- Create/edit areas.
- Add people/domains/repos/websites/tools/calendars/accounts as verified facts.
- Support skip and resume.
- Integrate into existing onboarding only behind feature flag.

Acceptance criteria:

- Jakob can create CardHunt, StatPearls, My Apps, Money Management, Trip
  Management, Relationship Management, Schedule Management, AI Development
  News, Music To Learn, and Habits.
- CardHunt and StatPearls are stored as job/work areas.
- Jakob can mark Andrew as boss for CardHunt only by explicit confirmation.
- The flow can be skipped without blocking the app.
- Setup output appears in Area profiles.

UX research:

- Reference Fabric/Tiimo/Finch onboarding for low-friction question patterns,
  then research newer onboarding and personalization flows before building.
- Avoid generic demographic questions.
- Ask "what are you responsible for?" rather than "what is your role?"

### Issue 4: Build Unassigned context review surface

Labels: albatross, 0.9.0, frontend, context-graph

Goal:

Create the daily hole-plugging surface for unknown senders, domains, people,
projects, and loud but unclear artifacts.

Scope:

- Add Unassigned surface.
- Show pending contextReviewItems.
- Actions: assign area, create area, mark noise, ignore sender/domain, ask later.
- Store corrections as verified/rejected facts or areaArtifactLinks.
- Show reasoning and source refs.

Acceptance criteria:

- Banjo course example can be classified as Music or Noise.
- Rewards sender can be marked Noise.
- Recruiter email can create or assign Job Search.
- User decisions update future classification.
- No item silently becomes permanent context.

UX research:

- Reference Notion Mail, Superhuman, and Shortwave for triage patterns; then
  use Mobbin and live product research to find fresher review/correction flows.
- Reference Linear and Plane for reason/source display; research beyond them
  before implementation.

### Issue 5: Build area-aware artifact classifier

Labels: albatross, 0.9.0, ai, backend, search

Goal:

Assign mail/calendar/tasks/MCP artifacts to areas as candidate/verified links,
with rare secondary-area support.

Scope:

- Area matching service over verified facts, candidate facts, smart labels,
  thread metadata, calendar event text, task provenance, and MCP items.
- Primary area plus rare secondary areas.
- Require reason for secondary assignment.
- Queue uncertain items in Unassigned.
- Never auto-verify people/area membership.

Acceptance criteria:

- A CardHunt thread with verified domain/person/repo context gets candidate or
  verified area assignment according to source trust.
- A thread can have one primary area and optional secondary areas.
- Secondary area assignment includes a reason.
- Low-confidence artifacts go to Unassigned.
- Existing smart categories continue to work.

Implementation notes:

- Existing smart categories become secondary lenses below areas, not the main
  mental model.
- Preserve current mail category behavior until area navigation is ready.
- Phase smart categories down only after area-based organization has proven
  itself in real use.

### Issue 6: Add Area navigation and area lenses

Labels: albatross, 0.9.0, frontend, mail

Goal:

Rethink the app around areas without breaking existing smart mail views.

Scope:

- Add Areas section to rail behind flag.
- Area view shows mail, tasks, events, people, facts, projects, and unassigned
  candidates for that area.
- Inside an area, support lenses: Needs Reply, Open Loops, Tasks, Events,
  Files/Links, People, Noise.

Acceptance criteria:

- User can open CardHunt area and see related threads/tasks/events/MCP items.
- User can still use old Smart categories.
- Area views make it clear which assignments are verified vs candidate.
- User can correct area assignment from thread/detail UI.

UX research:

- Reference Notion Mail for views and filters, then research newer mail/work
  organization UIs before implementation.
- Reference Linear/Plane for dense metadata and activity, then research beyond
  those examples.
- Keep the Dia "loud equals important" failure visible during design review.

### Issue 7: Implement New Intent floating capture button

Labels: albatross, 0.9.0, frontend, voice, intent

Goal:

Replace "Ask Assistant" as the primary proactive entry point with a playful,
voice-first New Intent capture surface.

Scope:

- Add New Intent button behind flag.
- Button copy can rotate: New Intent, New Idea, New Procrastination, Make This
  Real, Unload Thought.
- Implement the intended shape language: transparent, jiggly/hand-drawn border,
  hover expands into an organic/random shape, with a painting-easel or animated
  paper/paint-wash feel.
- Open modal/sheet with assistant-initiated prompt:
  "What are you trying to get out of your head?"
- Support text input first.
- Support voice capture/transcription using Lab86 Voice (`voice.lab86.io` and
  `/home/jjalangtry/repos/lab86-voice`) as inspiration for libraries, rendering
  voice agents, picture-in-picture, transcript display, and voice-to-intent
  interaction patterns. Do not directly move the app code unless a later
  implementation decision says to.
- Save raw dump immediately.

Acceptance criteria:

- Raw text/voice capture creates an intent record.
- Capture is one intent per click by default.
- User can still enter multiple items; system asks before splitting.
- Button remains accessible and reliable despite playful animation.
- Existing AIBar remains available for chat/replan.

UX research:

- Reference Tiimo and Apple Notes for voice/capture, Lab86 Voice for voice-agent
  UI, and research newer voice/ambient capture products before implementation.
- Avoid chat-blank-state feeling.
- Playful before activation, structured after activation.

### Issue 8: Build intent parser and classifier

Labels: albatross, 0.9.0, ai, backend, intent

Goal:

Convert raw intent input into a structured but provisional intent.

Scope:

- Classify intent as task/project/idea/obligation/errand/habit/relationship.
- Detect likely area.
- Detect whether project is needed.
- Detect required questions.
- Preserve assumptions separately from facts.
- Use artifact search results before finalizing questions.
- Always create an initial intent plan object after the capture/search/question
  loop.

Acceptance criteria:

- "I started a new job at CardHunt. My manager is Andrew..." becomes area setup
  candidates, not tasks.
- "Fuck, I need to file my taxes by April 15" becomes a Life Admin/Money
  obligation with deadline candidate.
- "Passport" alone asks for more detail instead of hallucinating renewal.
- The parser never promotes candidates to verified area facts.
- Every parsed intent has or creates an intent plan.

Questioning behavior:

- Ask many questions if needed.
- Prefer specific questions with choices where finite.
- Ask after artifact search when search can reduce ambiguity.

### Issue 9: Build artifact search context pack for intent planning

Labels: albatross, 0.9.0, backend, search, ai

Goal:

Make grabbing context from connected artifacts easy, safe, and area-aware.

Scope:

- Build a context-pack service for an intent.
- Search mail, calendar, tasks, MCP items, area facts, and previous intents.
- Return sourceRefs and confidence.
- Separate verified context, candidate context, and contradictions.
- Keep payloads compact for the model.

Acceptance criteria:

- Passport intent can find relevant old emails/docs/calendar events if present.
- CardHunt intent can pull verified CardHunt people/repos/domains.
- Candidate context is clearly marked candidate.
- Contradictions are surfaced as questions.
- Tests cover no-results, conflicting-results, and candidate-only contexts.

Implementation notes:

- This is the "best index ever" foundation.
- Artifact search should be reusable by Daily Report, Unassigned, and Replan.

### Issue 10: Build Intent Pane

Labels: albatross, 0.9.0, frontend, intent

Goal:

Create the object pane where raw intent becomes a plan.

Scope:

- Display raw source/transcript collapsed.
- Show outcome.
- Show digital actions.
- Show physical actions.
- Show questions.
- Show evidence/source refs.
- Show assumptions.
- Show proposed tasks/events/projects/emails.
- Allow user correction of area, classification, project need, and facts.

Acceptance criteria:

- Intent pane can represent passport/taxes/CardHunt/music examples.
- User can answer questions in-pane conversationally.
- User can correct "this is a project" vs "this is just a task."
- User can apply plan when ready.
- User can archive/pause/done an intent.

UX research:

- Reference Plane/Linear for issue detail and metadata rails, then research
  fresher object-pane and side-panel patterns.
- Reference Motion/Reclaim for scheduled plan representations, then research
  beyond those examples.
- Keep pane calm and operational after playful capture.

### Issue 11: Generate grounded intent plans

Labels: albatross, 0.9.0, ai, planning

Goal:

Generate realistic, grounded plans that separate digital actions from physical
actions.

Scope:

- Plan generator takes intent, area context, artifact context, and answers.
- Produces outcome, digital actions, physical actions, questions, assumptions,
  source refs, and proposed artifacts.
- Uses Browserbase/web research for real-life tasks when relevant.
- Supports "task only" vs "project with tasks" decisions.
- Proposes email drafts when the plan calls for communication.

Acceptance criteria:

- Passport plan does not assume renewal, possession, expiration, location, or
  progress.
- Taxes plan asks what is already done and what remains.
- CardHunt plan uses verified CardHunt area facts.
- Plans include official source refs for real-life requirements.
- Plans remain draft until applied.

Research/action rules:

- Official sources first.
- Ask which route applies.
- Never complete real-world action without user confirmation.
- Use Browserbase as much as possible for research and guided preparation.

### Issue 12: Apply plan through existing tools and operation batches

Labels: albatross, 0.9.0, backend, ai, operations

Goal:

Turn a ready plan into real tasks, calendar events, projects, and drafts through
existing safe mutation paths.

Scope:

- Create task cards via tasks_create_card.
- Create calendar events via calendar_create_event.
- Create email drafts via existing compose/draft tools.
- Create projects if needed.
- Attach provenance links.
- Record operationBatchId.
- Surface applied changes in the intent pane.
- Support undo and returning undone actions to plan state.

Acceptance criteria:

- Applying a plan creates a single reviewable operation batch.
- Applying a communication plan can create a draft without sending it.
- User can undo individual created artifacts.
- Undone items reappear in the plan as unresolved, not deleted from context.
- Human-facing actions enter approval queue instead of executing.

Regression rules:

- Do not bypass tool registry.
- Do not write directly to provider APIs from intent code.
- Existing tasks/calendar behavior remains unchanged.

### Issue 13: Build universal human approval queue

Labels: albatross, 0.9.0, safety, frontend, backend

Goal:

Create one recognizable approval treatment for actions involving other humans
or real-world irreversible effects.

Scope:

- Approval queue surface.
- Approval card component.
- Actions: approve, edit, reject.
- Undo timer/toast for supported actions.
- Integrate send email, invite attendees, RSVP, booking/buying/deleting later.
- Default undo timer for supported human-facing actions is 10 seconds.

Acceptance criteria:

- Draft email to Andrew requires approval.
- Calendar invite with attendees requires approval.
- RSVP requires approval.
- Approval card clearly shows area/intent/project source.
- Rejecting returns action to plan as blocked/rejected.
- Undoing a supported action returns it to the originating plan/artifact as
  unresolved rather than making it disappear.

UX notes:

- Use checkmark and x affordances.
- Show human-facing actions differently from internal task/calendar artifacts.
- Add interactive toast for the 10-second undo window.

### Issue 14: Add Project/Epic model and pane

Labels: albatross, 0.9.0, projects, tasks

Goal:

Represent long-running outcomes separately from tasks and intents.

Priority:

Lower than areas, intent capture, mandatory plans, and trust. Implement once
the core plan loop is working.

Scope:

- Add projects table and queries/mutations.
- Project pane: outcome, status, active sprint, intents, tasks, evidence, notes.
- Link intents to projects.
- Link task cards to projects.
- Archive/pause/done projects.

Acceptance criteria:

- Multi-step intent can create a project automatically when obvious.
- System asks when project need is unclear.
- Standalone tasks remain allowed.
- Project pane shows related tasks/events/threads/MCP items.

UX research:

- Reference Linear/Plane/Jira for project/issue relationships, then research
  fresher project/epic UI patterns before implementation.
- Keep projects lighter than Jira.

### Issue 15: Add Sprint model and task board tabs

Labels: albatross, 0.9.0, sprints, tasks, frontend

Goal:

Support time-boxed focus without forcing the user to become a project manager.

Priority:

Lower than areas, intent capture, mandatory plans, and trust. Sprints should not
block 0.9's first useful loop.

Scope:

- Add sprints table.
- Add task board tabs/filters: Kanban, Areas, Projects, Sprints.
- Let cards optionally belong to area/project/sprint/intent.
- Standalone cards still render.
- Add active sprint summary.

Acceptance criteria:

- Existing board cards render without new metadata.
- User can view tasks by project and sprint.
- User can archive or close a sprint.
- Weekly/monthly details can remain basic in 0.9.0.

### Issue 16: Integrate areas and intents into Daily Report

Labels: albatross, 0.9.0, daily-report, ai

Goal:

Make Daily Report respect verified areas and declared intent.

Scope:

- Add area context to report generation.
- Add "loud but not necessarily important" handling.
- Add first-report-of-month prompt.
- Keep the first-report-of-month prompt gentle and lightweight at first.
- Add Unassigned/context-review summary.
- Ask whether loud areas matter today.

Acceptance criteria:

- CardHunt being loud does not dominate report unless active/important.
- Report can ask: "CardHunt is loud today. Include it?"
- Monthly prompt appears in first Daily Report opened after a new month.
- Monthly prompt is not aggressive initially; tune later based on real use.
- Report includes active intents/projects without requiring existing artifacts.

Dia failure mode to avoid:

- Beautiful synthesis that assumes the loudest stream is the user's identity or
  priority. The reference failure: Dia saw CardHunt notifications and produced
  a polished CardHunt-centered report without asking what mattered today,
  without multi-account understanding, and without verified knowledge of the
  user's active areas.

### Issue 17: Build "Salvage Today" replan flow

Labels: albatross, 0.9.0, replanning, ai, calendar

Goal:

Make the app flexible when real life breaks the plan.

Scope:

- Natural language trigger through assistant/chat:
  "Fuck, I woke up at 11:30."
  "I forgot about this."
  "I am off track."
- Read remaining calendar, active tasks, active sprint, and intents.
- Ask time/energy constraints if needed.
- Propose realistic revised plan.
- Move/defer calendar blocks only with user approval or clear internal-only
  permissions.

Acceptance criteria:

- User can salvage a day after waking late.
- App preserves longer-term plan.
- App can defer nonessential tasks.
- App does not shame user.
- Tone is funny and slightly confrontational, never disappointed.

Tone sample:

> I know you will probably try to dodge this for another week, but if you do it
> now you do not have to think about it all next week. I doubt you will listen
> to me, but I made the slot anyway.

### Issue 18: Add progress reports and celebration moments

Labels: albatross, 0.9.0, frontend, delight

Goal:

Make progress visible and satisfying.

Scope:

- Project/area progress charts.
- Completion event storage for tasks, plans, intents, and projects.
- Weekly/monthly summaries.
- Data-backed progress comparisons, such as completion rate and average time
  before due date.
- Completion celebration animation.
- Optional sound/haptics hooks for future native app.
- Copy for "one less albatross."

Acceptance criteria:

- Completing an intent/project can trigger celebration.
- Completing a task records a completion event.
- Progress report shows what moved, what was avoided, what is next, and how
  completion behavior changed over time.
- Reports can say things like: "Three months ago you completed 50% of what you
  meant to do, on average 1.5 days before it was due. Now you complete 74%, on
  average 3 days before it is due."
- Celebration does not interrupt urgent workflows.
- Mobile/PWA experience remains usable.

Copy example:

> Wow, you got that passport done. That is one less albatross hanging around
> your neck.

### Issue 19: Mobile/PWA intent capture pass

Labels: albatross, 0.9.0, mobile, voice

Goal:

Make the 0.9.0 loop usable from phone without native app work.

Scope:

- Responsive New Intent capture.
- Mobile voice capture/transcription.
- Use Lab86 Voice as inspiration for mobile voice-agent rendering,
  picture-in-picture, transcript display, and capture ergonomics.
- Mobile intent pane.
- Mobile approval cards.
- Add-to-home-screen/PWA checks if applicable.

Acceptance criteria:

- User can capture a voice intent from phone.
- User can answer questions and approve/reject actions on phone.
- UI does not require desktop task-board interactions.
- Native app is not required for 0.9.0.

### Issue 20: Test, observability, and regression guardrails

Labels: albatross, 0.9.0, testing, quality

Goal:

Protect existing Mail/Calendar/Tasks behavior and prevent trust-breaking
Albatross failures.

Scope:

- Unit tests for context status transitions.
- Unit tests for intent parser output shapes.
- Tests for old task cards with missing area/project/sprint fields.
- Tests that applying plans uses tool registry.
- Tests that no permanent facts become verified without confirmation.
- Tests that every intent has an intent plan.
- Tests that completion events are stored when tasks/intents/projects complete.
- Tests that verified facts expose confirmation refs.
- Logging for candidate fact creation, confirmation, rejection, and plan apply.

Acceptance criteria:

- Feature flag off has no visible regression.
- Existing test suite passes.
- New tests cover trust boundaries.
- Albatross errors degrade gracefully.
- Daily Report ignores missing context graph data.

## GitHub Creation Notes

When ready to create issues:

1. Create a GitHub milestone named `0.9.0 - Albatross`.
2. Create labels if missing:
   - albatross
   - 0.9.0
   - context-graph
   - intent
   - areas
   - replanning
   - safety
   - voice
   - daily-report
3. Create the epic issue first.
4. Create each issue and link it back to the epic.
5. Add dependencies in issue bodies.
6. Keep implementation PRs small and additive.

Suggested command shape:

```bash
gh issue create \
  --repo Lab86-io/lab86-mail \
  --title "Albatross 0.9: Verified Intent Layer" \
  --label "epic,albatross,0.9.0,product,ai" \
  --body-file /tmp/albatross-epic.md
```

Do not create live issues until the epic order and labels are reviewed.

## First Implementation Recommendation

Start with these five issues:

1. Add Albatross feature flag and navigation shell.
2. Implement first-class Area and Area Fact schema.
3. Build Area Setup flow.
4. Build Unassigned context review surface.
5. Implement New Intent floating capture button.

Reason:

These establish the trust foundation before the app creates plans or artifacts.
Without verified areas and Unassigned, Albatross risks becoming another Dia-style
beautiful guesser.
