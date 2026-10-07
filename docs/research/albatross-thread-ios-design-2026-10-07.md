# The Albatross thread, iOS design note (2026-10-07)

> **Lead decisions override this note.** `docs/albatross-thread.md`, section "Cross-platform
> decisions (lead review, 2026-10-07)", settles the open questions. Where this note differs, the
> decisions win: no "sent your note to the run" row (decision 8), "Dismiss" for a run handoff and
> "Skip" for a chat form (decisions 3 and 4), and no "Check the page" in the thread (decision 5).
> The sections below are updated to match.

Status: design only. No production code changes. Branch `claude/albatross-chat`.

This note decides how the Albatross thread (`docs/albatross-thread.md`) looks and behaves on
iPhone and iPad. The data contract is `lib/albatross/thread-contract.ts`. The run contract is
`docs/albatross-step-runner.md`. The earlier iOS note, `step-runner-ios-design-2026-10-07.md`,
stays valid for the Brief list, the saved sign-ins setting, and the copy of run states. This
note replaces its Work page decisions (decisions 1 to 6 and 9 of that note).

The macOS designer reads this note too. Section 3 says which views are shared and which stay
on iOS.

## 0. What the screenshots show

The three web screenshots of 2026-10-07 show the Guided work page during the Alive at 25 run.
The same sentence appears three times: in the handoff card, in the browser bar, and in the chat.
Three "Continue" controls and two "Discuss this" controls sit on one screen. The chat panel
covers the form that the user must fill. The chat found the correct class, but the page still
shows the first class. The iOS Work page (`WorkDetailView.swift`) has the same structure: a
step card stack, a "Needs you" section, a separate chat scope, and a browser sheet.

The fix is one conversation. The run reports into it. The question is a form inside it. The
page is one sheet that the run block opens. The plan, the proof, and the files go to a sheet.

## 1. Research findings

### 1.1 Mobbin screens (iOS)

Each row names the screen, what the screen does, what the design takes, and what it rejects.

| Screen | What it does | Taken | Rejected |
|---|---|---|---|
| [Manus, task run](https://mobbin.com/screens/59294d00-2e82-406d-a422-a8efa4cd10ab) | A plan card lists steps. Done steps carry a check. The current step shows a "Thinking" line. Stop sits in the composer. | A done step collapses to one line with a check. The current step shows its newest line. | The plan card in every message. The plan lives in the plan sheet. Stop in the composer: the composer must stay free for a note to the run (S8). |
| [v0, build run](https://mobbin.com/screens/f4489226-373f-42bf-9839-26105c144eff) | Thin "Thought for 1s" rows and tool rows sit between prose paragraphs. | Prose explains each phase; thin rows carry the work. | A chevron on every row. Our log lines open nothing. |
| [Linktree, analysis](https://mobbin.com/screens/7e370793-4b21-4992-8738-e417d3ce22dc) | An "Analysis" header with a chevron, and four check rows on a vertical rule. | The header-and-rule grammar. It is already `AssistantWorkLogView`. The run block uses the same rule. | Nothing. |
| [Perplexity, agent run](https://mobbin.com/screens/70c2d0ff-7e27-41db-9f2a-1dcdd3a4b43b) | A tree of parallel tasks, one row for each action, and a round scroll-to-bottom control. | The "Newest" control when the user reads above the bottom. | Raw tool identifiers in rows. Our rows are sentences. |
| [Manus, task done](https://mobbin.com/screens/c64c719b-b356-44c9-827b-d7f826cb0201) | A result card with two buttons, a "Task completed" check line, and a final deliverable row. | The done line with one check. The artifact row with one verb. | Two buttons on one artifact. |
| [Liven, support chat](https://mobbin.com/screens/855a92be-de9a-434c-bf04-0ddd3d9b9872) | A pinned strip above the composer says "An agent will be with you shortly · You're up next". | The idea that the turn state must be visible without a scroll. We put it in the plan line of the navigation bar. | A pinned strip above the composer. The run block is the last item; a strip repeats it. |
| [Wabi, version cards](https://mobbin.com/screens/fd8cb6af-b1ce-4a3e-aab2-1bb2a43cf988) | Each change is a card with one undo control. | A receipt with one "Undo" (S11, "Saved to your details: Phone"). | The tall card chrome. Our receipt is one line. |
| [Mimo, build chat](https://mobbin.com/screens/bbdd642e-f639-4c04-bfe8-a8b22cfd0bc2) | The composer reads "Working on it…" and is locked while the agent works. | Nothing. | A locked composer. S8 needs the composer open while a run works. |
| [ChatGPT, research stopped](https://mobbin.com/screens/2add2805-fa2c-406b-bc82-fb3d6682d926) | A stopped run collapses to one line, "Research stopped", with an expand control. | A stopped or cancelled run block collapses to one line with its summary. | Nothing. |
| [ChatGPT, thinking](https://mobbin.com/screens/67a0c5d3-e9fc-4855-a616-18a662a92392) | A thin "Thinking" line. A stop control replaces send in the composer during the turn. | The composer's stop control for the chat turn (it exists). | The same control for a run. A run's "Stop" lives in its block, because the composer must still send. |
| [World of Hyatt, chat form](https://mobbin.com/screens/70f3aba0-3902-423d-b3c5-22b49b393e45) | A checklist, a required text area, a full-width submit, and a keyboard with Done. | The keyboard accessory with "Done". Required fields marked in the label. | A full-width submit. Ours sits at the trailing edge of the card, like `QuestionShell` today. |
| [Flo, survey](https://mobbin.com/screens/60d10634-cdbe-4746-823b-040780111c58) | A bottom sheet with a radio scale, a quiet "Skip", and "Send". | A quiet skip control above the primary, for chat forms only. | A separate sheet. The form is inline in the thread. |
| [WhatsApp, respond](https://mobbin.com/screens/f7d8cba0-46fb-49df-9201-0aad35f28629) | A sheet with four radio rows, full-row tap targets. | Full-row tap targets. | The sheet. The trailing radio; ours stays leading, as `OptionRow` does today. |
| [Bumble, opening move](https://mobbin.com/screens/1b8bf1e5-4b4e-463e-9577-1bb68d75af6f) | "Write your own" is a row above the choices. | "Other" is a row with a field. | Its place at the top. Ours is the last row. |
| [Honest Greens, bot form](https://mobbin.com/screens/2cb358ad-d092-4abc-8553-e914932a0953) | The bot asks for a phone number. A "Skip" pill floats. The composer becomes the field. | Nothing. | The composer as the field. Ours accepts the form and free text (S11). |
| [Urban Company, email ask](https://mobbin.com/screens/767d0263-aeed-4d0f-b564-f30e41fec07a) | A link in the bubble opens a sheet with one field and Submit. | Nothing. | The extra sheet. |
| [Natural AI, settings](https://mobbin.com/screens/3a141e7f-8fc6-4d06-807d-7adbb490ade6) | First, middle, last name, email, and phone in one card. | The three-part name. It matches `nameValueSchema`. | Inline editable fields in the list. Ours are rows that open an editor. |
| [Afterpay, personal](https://mobbin.com/screens/1ba3578c-31da-45f2-8e29-ea22b2860f5d) | Address, phone, and email rows with "Edit". A toggle "Autofill personal details" with one line of why. | The one-line "why" under the page title. | A global autofill toggle. Our control is per form ("Save to my details"). |
| [Cash App, personal information](https://mobbin.com/screens/8aa599a3-ba78-4ecf-b1fc-edc14ff05ba4) | An intro sentence under each section. "Remove" on each row. "Add phone" and "Add email" when missing. | The intro sentence, "Remove", and "Add" rows for missing details. | The identity verification row. |
| [Vipps, personal information](https://mobbin.com/screens/30c26c19-841e-43eb-a044-9d2e93c503ad) | Grouped rows. A footer says where the data is used. "Remove profile" is destructive and last. | The footer that says where the data goes. | Nothing. |
| [Instagram, personal details](https://mobbin.com/screens/af0ec85b-db7c-4d7e-8f48-5c75666e510b) | One explanation line under the title, then grouped rows with chevrons. | The explanation line. | Nothing. |
| [Apple Fitness, plan week](https://mobbin.com/screens/aff17240-e431-457f-9361-35bd51336726) | A two-line navigation title: "Jane's Plan" over "Week 1 of 3". | The two-line title: the Work title over the plan line. | Nothing. |
| [Vestiaire, listing steps](https://mobbin.com/screens/cc1332e3-daa4-4380-84d9-717988b85c32) | The title reads "2 steps left". Rows carry a check or a number. | The plan sheet rows: a check for done, a number for the rest. | The disabled "Review before submitting" button. |
| [Yuka, product form](https://mobbin.com/screens/0cee043b-2f0d-42e4-918c-456ad02bb8ef) | A thin progress bar under the title. | Nothing. | A progress bar for two to five steps. Words are enough. |

### 1.2 Reference products (Browserbase)

- **ChatGPT agent.** The help article (help.openai.com, 11752874) was behind a bot wall on
  2026-10-07. The earlier iOS note read it on the same day: the agent pauses at a sign-in and asks
  the user to take over; it takes no screenshots while the user has control; cookies persist;
  the user can clear saved logins. A secondary source
  ([claypier, 2026-08-26](https://claypier.com/en/chatgpt-work-cloud-browser-signin/)) adds: the
  task pauses when it needs input, a sign-in, or a confirmation; the sign-in form goes to the
  remote browser and the model never sees it; the user can inspect the live site before they
  continue; money and legal steps ask in chat. Decision: the run block says "Sign in to
  aliveat25.com in the page, then press Continue". The page sheet shows the real page. Albatross
  never sees a password.
- **Manus.** [Take over](https://help.manus.im/en/articles/11711218-how-can-i-take-over-manus-browser-or-vs-code)
  and [Cloud browser](https://www.manus.im/docs/features/cloud-browser): Manus prompts the user
  to take over at a verification; the user can also take over at any time; the user hands control
  back and Manus continues; the user sees everything in real time. Decision: "Take over" is
  always in the page sheet while Albatross has the page. After a take-over the sheet offers
  "Continue".
- **Perplexity Comet on iOS.**
  [MacStories, 2026-03-18](https://www.macstories.net/news/comet-is-the-first-agentic-browser-for-ios-worth-trying/):
  Comet on iPhone is a WebKit browser with an assistant button in a Liquid Glass address bar. The
  agent acts in the user's own tabs. There is no remote page on iPhone. Decision: on iPhone the
  page is the real remote page in a sheet, not a screenshot. The sheet has a glass toolbar with
  verbs only.

### 1.3 Apple guidance

- [HIG, Sheets](https://developer.apple.com/design/human-interface-guidelines/sheets): a sheet
  on iOS can be nonmodal; detents are medium and large; Cancel or Close goes on the leading edge
  and Done on the trailing edge; show only one sheet at a time. Decision: the page sheet is
  nonmodal with medium and large detents, so the user can read the thread with the page at
  medium (S7, S8). The plan sheet, the details sheet, and the page sheet never stack.
- [HIG, Text fields](https://developer.apple.com/design/human-interface-guidelines/text-fields):
  show a label as well as a placeholder; validate an email when the person leaves the field;
  show the keyboard that fits the content; show a clear button. Decision: the form card validates
  on focus loss and on submit, not on each keystroke.
- [HIG, Entering data](https://developer.apple.com/design/human-interface-guidelines/entering-data):
  get information from the system when possible; prefill with defaults; offer choices instead of
  text; make the Continue button available only after the required data is present. Decision:
  bound fields prefill from Personal details (S10, S20); the submit control stays disabled until
  the required fields have values.
- [UITextContentType](https://developer.apple.com/documentation/uikit/uitextcontenttype): the
  kinds `givenName`, `middleName`, `familyName`, `emailAddress`, `telephoneNumber`,
  `streetAddressLine1`, `streetAddressLine2`, `addressCity`, `addressState`, `postalCode`,
  `countryName`. Decision: every typed field names its content type so iOS AutoFill offers the
  user's own contact card.
- [SwiftUI navigationSubtitle](https://developer.apple.com/documentation/swiftui/view/navigationsubtitle(_:)):
  iOS 26 shows a subtitle under the navigation title. Decision: the plan line can use it, but S3
  needs a tap on the line. The design uses a principal toolbar button with two lines and keeps
  `navigationSubtitle` as the fallback when a principal item is not possible.
- [Liquid Glass overview](https://developer.apple.com/documentation/technologyoverviews/liquid-glass):
  standard bars and controls take the material; be careful with colour in controls so content
  shows through. Decision: the composer keeps its glass capsule; the page sheet toolbar is the
  standard glass bar; the run block and the form card are paper surfaces, not glass.

## 2. Screen structure

### 2.1 Navigation

- `WorkThreadView` replaces `WorkDetailView` as the `navigationDestination` for
  `navigation.workRoute` in `WorkView.swift` and `AreaDetailView.swift`.
- Entry points stay as they are: the Albatrosses list, an Area, the Brief ("Ready for you" and
  the edition), Today, Activity, a chat card (`open_work`), the wake nudge, and the deep link
  `/?view=albatrosses&work=<workId>` from a `work_question` push.
- `WorkRoute` gains `intent: Intent?` with cases `.openPage` and `.focusComposer`. A "Ready for
  you" row whose handoff is `sign_in` or `finish_on_page` opens the thread with `.openPage`, so
  the page sheet opens at once (S5). A push while the thread is on screen bumps
  `navigation.workRefreshToken`; the thread re-reads its runs.
- The Chat tab keeps `AssistantChatView` for global and Area chats. A Work chat started from
  anywhere else now opens the thread instead (`startAssistantChat(scope: .work)` routes to
  `openWork`).

### 2.2 The navigation bar

- Display mode inline. Back goes to the list, the Area, or the Brief.
- Principal item: one button with two lines. Line 1, the Work title in `.headline`, one line,
  truncated at the tail. Line 2, the plan line in `.caption` secondary: "Step 1 of 2 · Your turn".
  The tap opens the plan sheet. VoiceOver label: "Register for the Alive at 25 course. Step 1 of
  2, your turn. Opens the plan." At accessibility text sizes the button shows the plan line only.
- The plan line words, by thread state (section 5.4): "Albatross makes the plan", "Step 1 of 2",
  "Step 1 of 2 · Albatross works", "Step 1 of 2 · Your turn", "Step 1 of 2 · Needs an answer",
  "Done", "Put down", "Step 1 of 2 · Ready for you".
- Trailing item: a menu with the ellipsis glyph (the only icon in the bar). Items, in order:
  "Details", "Split…", "Put it down" (or "Pick it up" when the Work is paused), "Set horizon…",
  "Mark done", a divider, "Archive…" (destructive). "Discuss Work", "Continue Planning", and the
  shape picker leave the menu. The shape word moves into the details sheet.
- "Split…" puts "Split this into: " into the composer and focuses it. The chat agent does the
  split. One voice, no second form.

### 2.3 The conversation list

- One `ScrollView` with a `LazyVStack`, the same paper and spacing as `AssistantChatView`.
- Items, oldest first: the outcome block, then the merged timeline (section 6.2), then the
  chat error and retry row when present.
- The outcome block is the first item. It shows the outcome sentence in `.title3`, the plan
  summary in `.body` secondary, and one compact row for each step (check or number, title, one
  state word). The current step offers "Handle it" when runnable. While the plan is not ready
  the block says "Albatross makes the plan." with a `RevealDot`.
- A user message is the raised bubble it is today. An assistant message is document text with
  its work log, cards, and forms, as today.
- A run block (section 5.1) is a paper block with the work-log rule on its left. A run that a
  message started renders inside that message, in place of its `albatross_handle_step` row.
- Scroll: the list opens at the bottom (`defaultScrollAnchor(.bottom, for: .initialOffset)`).
  New items keep the bottom in view only when the user is at the bottom
  (`defaultScrollAnchor(.bottom, for: .sizeChanges)` plus a `onScrollGeometryChange` guard).
  When the user reads above the bottom and an item arrives, a text pill "Newest" appears above
  the composer at the trailing edge. A tap scrolls to the bottom. Log lines that arrive inside an
  open run block do not move the scroll position when the user is above the bottom.

### 2.4 The composer

- Reuse the composer of `AssistantChatView` as it is: the glass capsule, the attach control, the
  "Ask or hold" field, the route chip, the send and stop controls.
- In the thread the context chip ("Work: …") hides. The thread is the context.
- The placeholder reads "Write to Albatross" in a thread. The route chip stays, because a Hold
  from inside a thread still makes new Work (the receipt row says so).
- While a run is open the send control stays active. A sent message reaches the run as a steer
  note (S8). The composer's stop control only stops a chat turn, never a run.
- The keyboard: `scrollDismissesKeyboard(.interactively)` stays. A form field inside a card gets
  a keyboard accessory with "Done". The focused field scrolls into view above the keyboard; the
  system does this inside the `ScrollView`.

### 2.5 The plan sheet

- `PlanSheet`, presented from the principal button. Detents: medium and large. Title "Plan".
  Leading "Close". No trailing button.
- One row for each step: a check (done), a number (next), or a `RevealDot` (a run works on it).
  Title, one state word, and for a done step its proof line ("Verified on the page · Oct 7").
  A runnable step shows "Handle it" at the trailing edge. A step with a URL shows "Open the site"
  in its context menu. The row of the current step is marked with the accent colour.
- A tap on a step row scrolls the thread to the newest run block of that step and closes the
  sheet.
- The footer says "Albatross keeps the plan here. Say what changed in the conversation, and the
  plan follows." in `.footnote` secondary.

### 2.6 The details sheet

- `DetailsSheet`, from the menu. Large detent only. Title "Details". Leading "Close".
- Sections, in order: Outcome (title, summary, the shape word with the picker, the horizon line
  with the horizon sheet); Shape body for list, practice, and milestones shapes (`ListBody`,
  `PracticeBody`, `ProjectBody` move here); Commitments (`OutcomeContractView`); Proof
  (`ProofTimelineView`); Files (the artifacts of every run, newest first, each row with one verb
  and "Undo" where an operation id exists); Plan document (`BriefDocumentView` or the artifact
  web view); Context (assumptions, sources); Older chats (the work-scoped sessions that are not
  the canonical one; a row opens it read-only in the Chat tab).

### 2.7 The page sheet

- `PageSheet` replaces `StepRunBrowserSheet` and `SharedBrowserSheet`. It has one owner value:
  `.run(StepRunView)` or `.user(step)`.
- Presentation: a `NavigationStack` sheet. Detents medium and large.
  `presentationBackgroundInteraction(.enabled(upThrough: .medium))` so the thread stays readable
  and the composer stays usable at medium. The sheet opens at medium while Albatross has the
  page and at large when it is the user's turn.
- Title: the site host ("aliveat25.com"). Subtitle: the step title.
- Status bar under the title: one dot (accent-2 while Albatross has the page, accent for the
  user) and one line. The copy table is in the earlier note and section 5.3 here.
- Trailing toolbar button: "Take over" while Albatross has the page; the handoff label
  ("I paid", "I signed in") when it is the user's turn, with "Continue" as the fallback; "Check
  the page" for a user-owned session. Leading: "Close".
- The sheet never stacks on another sheet. If the plan or details sheet is open, it closes first.

## 3. Component inventory

### 3.1 Reuse

| What | Where | Use in the thread |
|---|---|---|
| `AssistantChatView` transcript rows and composer | `Features/Assistant/AssistantChatView.swift` | Split into `AssistantTranscriptRows` and `AssistantComposer` so the thread and the Chat tab share them. The file keeps `AssistantChatView` for the Chat tab. |
| `AssistantChatModel` | `Features/Assistant/AssistantChatModel.swift` | Thread mode: `scope: .work`, `sessionID: workThreadSessionId(workId)`, `restore` on open. New: read `start` and `message-metadata` chunks into `metadata.createdAt`; write `metadata.createdAt` on user messages; render `albatross_handle_step` rows by shape. |
| `AssistantWorkLogView`, `AssistantWorkLogRowView`, `AssistantReasoningLine` | `AssistantWorkLogView.swift` | Chat turns in the thread. The run block borrows the rule and row style. |
| `AssistantShapeCardView`, `AssistantToolCardView` | `AssistantShapeCards.swift`, `AssistantToolCards.swift` | Cards in chat turns. New shape kinds `step_run` and `personal_details_saved` in `ToolShape.swift`. |
| `AssistantQuestionCard`, `QuestionShell`, `OptionRow`, `SubmitButton`, `AnswerSummary` | `AssistantQuestionCards.swift` | The four `ask_*` kinds stay. `QuestionShell`, `OptionRow`, `SubmitButton`, and `AnswerSummary` become internal (not private) so `FormQuestionCard` reuses them. |
| `StepRunLogView`, `StepRunCopy`, `StepRunNextBehaviour`, `StepRunActions` | `Features/Work/StepRunCard.swift`, `StepRunPresentation.swift` | The log rows, the words, the next-action table, and the open helpers. `StepRunCardState` and `StepRunCardPolicy` go away. |
| `StepRunBrowserPresentation`, `LiveViewWebView` | `StepRunPresentation.swift`, `SharedBrowserView.swift` | The page sheet's status line rules and the web view. |
| `ReadyForYouSection` | `Features/Today/ReadyForYouSection.swift` | Unchanged, except the row passes `WorkRoute.Intent.openPage` for page handoffs. |
| `HorizonSheet`, `ShapePickerSheet`, `OutcomeContractView`, `ProofTimelineView`, `ListBody`, `PracticeBody`, `ProjectBody`, `BriefDocumentView` | `Features/Work/` | Inside the details sheet. |
| `SavedSignInsView`, `StandingOrdersView` | `Features/Settings/` | Unchanged. |
| `surfaceCard`, `paperColor`, `elevatedColor`, `subtleColor`, `hairlineColor`, `RevealDot`, `PlatformAccessibility.announce` | `Core/Theme/Surface.swift`, `RevealedMarkdownView.swift`, `Core/Platform/PlatformAdaptions.swift` | Surfaces, the live dot, and announcements. |

### 3.2 New

| File | What it holds |
|---|---|
| `Core/Models/ThreadModels.swift` | `ThreadRunView` (`StepRunView` plus `parentRunId`, `question`), `ThreadQuestion`, `FormQuestion`, `FormField`, `FormOption`, `FormAnswer`, `FormFieldValue`, `legacyQuestionToForm`, `workThreadSessionId`. JSON init with the same tolerance as `StepRunModels.swift`. |
| `Core/Models/ThreadTimeline.swift` | `ThreadItem` (`.outcome`, `.message`, `.run`) and `ThreadTimeline.merge(messages:runs:)`, a pure port of `mergeThreadTimeline`. Tests mirror the TS tests. |
| `Core/Models/PersonalDetailsModels.swift` | `PersonalDetailKey`, `PersonalDetailView`, the value structs, `PersonalDetailSource`, the display line builder, the refused-value error. |
| `Core/Models/PersonalDetailsStore.swift` | `GET/PUT/DELETE /api/personal-details`, a 60 s cache, `prefill(form:)`, `previousValue(for:)` for Undo. |
| `Core/Models/WorkThreadStore.swift` | Runs for one Work: `GET /api/albatross/work/[workId]/runs`, the 3 s poll while a run is open, `start`, `stop`, `resume`, `dismiss`, `answer(question:form:)`. Wraps the existing `ProductStore` run calls. |
| `Features/Work/WorkThreadView.swift` | The screen: navigation bar, principal button, menu, the list, the composer, the sheets, the "Newest" pill, the refresh hooks. |
| `Features/Work/WorkThreadModel.swift` | Owns one `AssistantChatModel` in thread mode, one `WorkThreadStore`, the `WorkDetail` read, and the merged `items`. Computes the plan line and the thread state. |
| `Features/Work/OutcomeBlockView.swift` | The first item: outcome, summary, compact steps, "Handle it", the planning state. |
| `Features/Work/RunBlockView.swift` | Every run state (section 5.1), the page row, the steer-note row, the artifacts, the question form, the buttons. |
| `Features/Work/RunChainView.swift` | Joins a run and its continuations (`parentRunId`) into one visual block with "Continued" rules. |
| `Features/Assistant/FormQuestionCard.swift` | The form for `ask_form` and runner questions: title, detail, fields, "Save to my details", submit, skip, receipts. |
| `Features/Assistant/FormFieldViews.swift` | One view for each field kind: `ChoiceField`, `TextLineField`, `NumberField`, `PhoneField`, `EmailField`, `DateField`, `NameField`, `AddressField`, `ContactField`. Each sets `textContentType`, `keyboardType`, and its validator. |
| `Features/Assistant/FormValidation.swift` | Pure validators for each kind and the "is new or different" rule for bound fields. |
| `Features/Work/PlanSheet.swift` | Section 2.5. |
| `Features/Work/DetailsSheet.swift` | Section 2.6. The body of today's `WorkDetailView` moves here, minus the step section. |
| `Features/Work/PageSheet.swift` | Section 2.7 and section 5.3. Replaces both browser sheets. |
| `Features/Settings/PersonalDetailsSettingsView.swift` | The list (S21) and `PersonalDetailEditorView` for each key, including the custom detail editor. |
| `Lab86MailTests/ThreadTimelineTests.swift`, `FormValidationTests.swift`, `FormQuestionCardTests.swift`, `RunBlockPresentationTests.swift`, `PersonalDetailsStoreTests.swift`, `WorkThreadModelTests.swift` | The tests. Rendering tests write PNGs to the evidence directory for the Native acceptance CI. |

### 3.3 Change

- `Features/Assistant/ToolShape.swift`: add `.stepRun(runID:workID:action:)` and
  `.personalDetailsSaved(keys:labels:)` content kinds.
- `Features/Assistant/AssistantWorkLog.swift`: `AssistantQuestionPart.Kind` gains
  `.form = "ask_form"`.
- `Features/Assistant/AssistantToolGrammar.swift`: sentences for `albatross_handle_step`
  ("Starting on the step" / "Started on the step"), `albatross_stop_step`, `ask_form`
  ("Asking you one form" / "You answered"), `personal_details_get` ("Reading your details" /
  "Read your details"), `personal_details_save` ("Saving to your details" / "Saved to your
  details").
- `Features/Shell/NavigationModel.swift`: `WorkRoute.intent`, `workRefreshToken`, and
  `startAssistantChat(scope: .work)` routes to `openWork`.
- `App/AppEnvironment.swift`: `startAssistantChat` for `.work` opens the thread.
- `Features/Settings/SettingsView.swift`: a "Personal details" row in the Account section,
  under "Connections". The Trust footer adds one sentence: "Personal details are what Albatross
  types into forms."
- `Core/Models/StepRunModels.swift`: `WorkRoute` moves out; nothing else.
- `Features/Today/ReadyForYouSection.swift`: pass the intent.

### 3.4 Delete

- `Features/Work/WorkDetailView.swift`: the file goes. Its sections become `DetailsSheet.swift`.
  The step section (`currentStepSection`, `currentStepActions`, `stepSiteActions`, the step
  notes, the "Needs you" section) goes with no replacement; the run block and the form card do
  that work.
- `Features/Work/StepRunCard.swift`: `StepRunCardView` goes. `StepRunLogView` and
  `StepRunActions` move to `StepRunPresentation.swift`.
- `Features/Work/StepRunPresentation.swift`: `StepRunCardState`, `StepRunCardPolicy`,
  `StepRunCopy.sectionTitle` go.
- `Features/Work/WorkQuestionOptionsView.swift`: goes. `legacyQuestionToForm` feeds
  `FormQuestionCard`.
- `Features/Work/SharedBrowserView.swift`: `SharedBrowserSheet` and `StepRunBrowserSheet` go
  into `PageSheet`. `LiveViewWebView` moves to `PageSheet.swift`.
- "Discuss Work", "Discuss this", "Answer in chat", and the composer context chip in a Work
  chat go.

### 3.5 What the macOS designer takes

Shared, platform-neutral (the Mac mounts them in its detail column):

- `ThreadModels`, `ThreadTimeline`, `PersonalDetailsModels`, `PersonalDetailsStore`,
  `WorkThreadStore`, `WorkThreadModel`.
- `OutcomeBlockView`, `RunBlockView`, `RunChainView`, `FormQuestionCard`, `FormFieldViews`,
  `FormValidation`, the plan sheet content (`PlanListView`), the details sheet content
  (`WorkDetailsBody`), `PersonalDetailsSettingsView` and its editor (with `macForm` tweaks).
- The copy tables of this note.

iOS only:

- `WorkThreadView` (the principal two-line button, the menu placement, the "Newest" pill, the
  keyboard accessory, the sheet detents).
- `PageSheet` as a sheet. The Mac keeps `MacStepRunLivePane` beside the thread and takes the
  status-line rules from `StepRunBrowserPresentation`. On iPad the page is an inspector
  (section 7.2); the Mac pane and the iPad inspector can share one `PagePaneView`.
- The Mac tour needs new screens for the thread, the form, and Personal details.

## 4. User stories as iPhone screen states

Sample data in this section is invented: Sam Rivera, sam.rivera@example.com, (555) 010-0100,
12 Elm Street, Apt 3, Springfield, IL 62704. The course site is the brief's aliveat25.com. The
classes are Mon Oct 19 4:00–8:00 PM, Wed Oct 21 4:00–8:00 PM, Sat Oct 24 9:00 AM–1:00 PM, all
Zoom, all $70. The court date is November 2.

### S1. Open from anywhere

- From the Albatrosses list: push. The navigation bar shows "Register for the Alive at 25
  course" over "Step 1 of 2 · Your turn". The list opens at the bottom. The last item is the
  run block with its handoff; its primary button is "Check and pay" and the composer is under it.
- From a push notification: the same screen. If the handoff is `sign_in` or `finish_on_page`,
  the page sheet opens at large on top.
- From a chat card: the same push, on the Albatrosses tab.
- Loading: the bar shows the route title, the list shows the cached thread, and a one-line
  "Showing the last saved conversation." stays at the top until the reads return.

### S2. A new Albatross

- Open right after capture. The outcome block: "Register for Alive at 25 before Nov 2" in
  `.title3`; under it "Albatross makes the plan." with a `RevealDot`. The plan line reads
  "Albatross makes the plan". The composer is active.
- When the plan lands (the `WorkDetail` read returns steps), the block crossfades to: the
  outcome, the summary "Course at aliveat25.com must be finished before the November 2 court
  appearance.", and the steps "1 Register for the course · Albatross can handle it",
  "2 Attend the court appearance on November 2 · You". The first step row shows "Handle it".
  The plan line reads "Step 1 of 2".

### S3. The plan at a glance

- The principal button reads "Register for the Alive at 25 course" over "Step 1 of 2 · Your
  turn". A tap opens the plan sheet at medium.
- Plan sheet rows: "1 Register for the course" with the accent mark and "Your turn"; "2 Attend
  the court appearance on November 2" with "Next". After step 1 is done: a check, "Register for
  the course", "Verified on the page · Oct 19".
- A runnable step row shows "Handle it" at its trailing edge.

### S4. Older chats

- The thread loads `work-<workId>`. The server already moved the newest work chat into it.
- Details sheet, "Older chats": "Oct 5 · Which class should I pick?" rows. A tap opens the chat
  read-only in the Chat tab with a top line "An older chat about this Albatross. Write in the
  Albatross to continue."

### S5. Away and back

- The Brief started a run at 7:02. The user opens the thread at 8:30. Items, in order: the
  outcome block; a run block "Started by the Brief · 7:02" with "Did 6 things", collapsed; its
  summary "I found three classes before November 2 and opened the registration form."; one
  artifact row "Class options · Page"; the handoff "Albatross needs one answer" with the form
  (S9). The list is at the bottom. The form is next to the composer.
- The same push deep link opens the same screen.

### S6. Start

- A tap on "Handle it" in the outcome block or the plan sheet posts `start`. The block appears
  at once: "Working on: Register for the course", "Waiting to start.", "Started by you",
  "Stop". The plan line reads "Step 1 of 2 · Albatross works".
- Or the user writes "go ahead and register me". The Albatross reply shows a row "Started on the
  step" and the run block renders inside that reply.
- The first log line replaces "Waiting to start." The block keeps the newest three lines visible
  and offers "Show all 7 lines".

### S7. Watch the page

- When the run has a browser session, a row appears in the block under the log: "Albatross is on
  the page · aliveat25.com" with "Open" at the trailing edge.
- "Open" presents the page sheet at medium. The status bar reads "Opening the class list" (the
  session detail) with the accent-2 dot. The trailing button is "Take over".
- The user drags the sheet to large to see the page. At medium the thread stays readable and the
  composer works.

### S8. Talk while it works

- With the run open, the user writes "use the Monday class". The message appears as a bubble.
  Albatross answers in one line: "Noted. I will use the Monday class." No extra row appears.
- The run block shows a new log row with the quote style: "Read your note: use the Monday class".
- No second run block appears. The plan line does not change.

### S9. A choice that is mine

- The run hands off with `needs_answer`. The block headline reads "Albatross needs one answer".
  Summary: "I found three classes before November 2. I did not pick one. Your calendar is
  free on two of them."
- The form card (section 8.2): title "Which class?"; options, first the Monday one. Each option:
  label "Monday, October 19", detail "4:00–8:00 PM · Zoom · $70", calendar note "Free on your
  calendar". The Wednesday option says "Conflicts with Team sync" in red. The Saturday option
  says "Free on your calendar".
- The plan line reads "Step 1 of 2 · Needs an answer".

### S10. Missing details in the same form

- The same card continues under the options with "Your details for the form". Fields: Name,
  prefilled "Sam Rivera" with the line "From your account"; Email, prefilled
  "sam.rivera@example.com", "From your account"; Home address, prefilled "12 Elm Street, Apt 3,
  Springfield, IL 62704", "From your details"; Phone, empty, placeholder "(555) 010-0100".
- A toggle "Save to my details", on. Its footnote: "Albatross uses saved details in later forms."
- The submit button reads "Continue". It is disabled until Phone has a valid value.
- One tap submits. The card becomes a receipt (S10 receipt in section 5.2) and the run
  continues: a new run block, "Continued", with "Working on: Register for the course".

### S11. Answer in my own words

- The user ignores the form and writes "Monday works, my phone is 555 010 0100".
- The assistant turn: a row "Saved to your details", then a one-line receipt card "Saved to your
  details: Phone" with "Undo" at the trailing edge; then text "Thanks. I sent your answer to the
  run."
- The form card collapses to "Answered in the chat." with the answer line "Monday, October 19 ·
  Phone (555) 010-0100". The run continues as in S10.
- "Undo" removes the phone (DELETE) and the receipt reads "Removed from your details: Phone".

### S12. Sign in

- The run hands off with `your_turn`, `sign_in`. The headline "Your turn". Detail: "Sign in to
  aliveat25.com in the page, then press Continue." Buttons: "Sign in" (primary, opens the page
  sheet at large), "Continue", and a quiet "Dismiss".
- The page sheet: title "aliveat25.com", status "Sign in on the page. Albatross does not see
  your password.", trailing "I signed in".
- A tap on "I signed in" sends `resume`. The status bar changes to "Albatross checks the
  page…", the button disables. When the new run takes the page the dot turns accent-2, the
  status reads the run's detail, the sheet drops to medium, and the trailing button is "Take
  over". Or the user writes "done" in the composer; the chat agent resumes the run and the
  sheet follows.
- Next time: no sign-in handoff. The block log reads "Opened aliveat25.com, still signed in".

### S13. The final page

- The run hands off with `your_turn`, `finish_on_page`. Headline "Your turn". Summary: "I
  filled in the form for Monday, October 19 with your name, email, phone, and address."
  Detail: "Everything is filled in. Check it and pay the $70." Primary "Check and pay" opens the
  page sheet at large. A second button "I paid". A quiet "Dismiss".
- After payment the user presses "I paid" (in the sheet or in the block). The sheet status reads
  "Albatross checks the page…". The run resumes, checks the confirmation, and ends `done`.
- The block becomes the done block: "Done · Verified on the page", proof "Registration
  confirmed for Monday, October 19. Confirmation number ends in 0100.", one artifact row
  "Confirmation page · Page". The plan line reads "Step 2 of 2". Albatross writes one line:
  "Next: attend the court appearance on November 2. I will watch for the Zoom invite."

### S14. Drafts and documents

- A `ready_for_you` handoff with `review_draft`: headline "Ready for you", summary "I wrote a
  note to the court clerk with the registration confirmation.", artifact row "Note to the court
  clerk · Draft", primary "Read and send". The tap opens the composer sheet with the draft and
  its id.
- A document: artifact row "Registration confirmation · Document" and primary "Open the
  document". The tap opens the document by id.

### S15. Done

- The done block (S13). The plan sheet shows the check and the proof line. The plan line moves
  to the next step. VoiceOver announces "Step done. Register for the course. Verified on the
  page."

### S16. Failed or stopped

- Failed: headline "This run did not finish." in primary, the error line in red, for example
  "aliveat25.com did not load after three tries.", the collapsed log "What I did", and "Try
  again". The plan line returns to "Step 1 of 2".
- Stopped by a limit: "Albatross stopped at its time limit.", the summary, the artifacts, and
  "Continue".
- Stopped by the user: one line "Stopped by you." with "Continue" at the trailing edge. The
  summary opens on tap.

### S17. Ask

- The user writes "when is the court date?". Albatross answers "November 2 at 9:00 AM, at
  the Monroe County Hall of Justice. It is on your calendar." with one event card. No run starts.

### S18. Change the plan

- The user writes "I already registered, skip that". The Albatross reply shows rows "Recorded
  progress" and "Replanned the Work", then "Done. Step 1 is marked done as reported. Next: the
  court appearance on November 2." The plan line reads "Step 2 of 2". The outcome block's step
  row 1 shows a check with "Marked done".

### S19. Details

- The menu, "Details": the details sheet (section 2.6). The files section lists "Note to the
  court clerk · Draft · Undo", "Confirmation page · Page". "Split…", "Put it down", "Set
  horizon…", "Mark done" are in the menu, not in the sheet.

### S20. It knows me

- The run log reads "Read your details: name, email, address" then "Typed your name, email, and
  address". No form appears for them. Only the phone is asked (S10).

### S21. Settings

- Settings, Account, "Personal details". The page (section 8.4): title "Personal details", the
  line "Albatross types these into forms when a step needs them.", then rows Name "Sam Rivera ·
  From your account", Email "sam.rivera@example.com · From your account", Phone "(555) 010-0100
  · You told Albatross on Oct 7", Home address "12 Elm Street, Apt 3, Springfield, IL 62704 · You
  saved this on Oct 7", Emergency contact "Add", then "Other details" with "Add a detail".
- The footer: "Albatross never saves passwords, card numbers, or ID numbers here. Delete any
  detail at any time."
- A row opens the editor (section 8.5). "Delete" is the last control for a saved detail.

### S22. Found in my mail

- The form's Phone field is prefilled "(555) 010-0100" with the line "From your email
  signature" (`valueSource`). "Save to my details" is on because the value is new. On submit the
  receipt reads "Saved to your details: Phone".

### S23. My legal name

- Settings, Personal details, Name: "Sam rivera · From your account". The editor shows First
  "Sam", Last "rivera", and the line "Your account says Sam rivera. Forms use what you save here."
  The user fixes the last name and saves. The row reads "Sam Rivera · You saved this on Oct 7".
  A "Use the account name" control in the editor removes the saved copy.

### S24. Something it must not keep

- The user writes a Social Security number in the composer. The assistant answers "I do not keep
  that number. Albatross cannot store ID numbers yet. Type it on the page yourself when the
  form needs it." No receipt card appears. In Settings the editor refuses the same value with
  "Albatross does not keep this number here." under the field.

## 5. State matrices

### 5.1 Run block

| State | Header | Body | Controls | Plan line |
|---|---|---|---|---|
| queued | `RevealDot` + "Working on: {step}" | "Waiting to start." · "Started by you" | "Stop" | "Step n of m · Albatross works" |
| running | same | newest three log lines, "Show all N lines"; page row when a session exists | "Stop" | same |
| running, steered note read | same | a quote-style log row "Read your note: {note}" | "Stop" | same |
| handed_off `needs_answer` | "Albatross needs one answer" | summary, `FormQuestionCard` | the form's submit; quiet "Dismiss" | "Step n of m · Needs an answer" |
| handed_off `your_turn`, `sign_in` | "Your turn" | summary, detail, page row | `next.label` (opens page sheet), "Continue", quiet "Dismiss" | "Step n of m · Your turn" |
| handed_off `your_turn`, `finish_on_page` | "Your turn" | summary, detail, artifacts, page row | `next.label`, "I paid"-style second button from `next.label` when the label names the act, else "Continue"; quiet "Dismiss" | same |
| handed_off `your_turn`, `do_offline` | "Your turn" | summary, detail | "Mark this step done", quiet "Dismiss" | same |
| handed_off `ready_for_you`, `review_draft` | "Ready for you" | summary, artifact rows | "Read and send", quiet "Dismiss" | "Step n of m · Ready for you" |
| handed_off `ready_for_you`, `review_document` | "Ready for you" | summary, artifact rows | "Open the document", quiet "Dismiss" | same |
| handed_off `ready_for_you`, `approve` | "Ready for you" | summary | "Approve the invite" (Activity), quiet "Dismiss" | same |
| handed_off `review` | "Ready for you" | summary, artifacts | "Open" when a url exists, else none | same |
| handed_off `stopped` (`continue`) | "Albatross stopped at its time limit." or cost | summary, artifacts, "What I did" | "Continue", quiet "Dismiss" | "Step n of m" |
| done | check + "Done · {verification label}" | proof line (summary), artifacts; log collapsed | none; artifacts open on tap | "Step n+1 of m" or "Done" |
| failed | "This run did not finish." | error in red, "What I did" | "Try again" | "Step n of m" |
| cancelled | "Stopped by you." one line | summary on tap | "Continue" | "Step n of m" |
| closed (dismissed) | one line "Dismissed." in tertiary | nothing | none | "Step n of m" |
| continued chain | the parent block, then a thin rule "Continued · 9:41", then the child's body | the child's state from this table | the child's controls | the child's |

Rules: one primary button at most. "Dismiss" is borderless. No "Discuss this". A tap on the
header of a finished block toggles its log. The trigger line ("Started by the Brief") sits in
the header as tertiary text after a middle dot.

### 5.2 Form card

| State | What shows | Submit |
|---|---|---|
| pending, empty | title, detail, fields, "Save to my details" hidden | disabled |
| pending, prefilled | bound fields filled, each with "From your account" or "From your details" or `valueSource`; "Save to my details" on when a bound value is new or differs | enabled when required fields are valid |
| choice | radio or check rows, detail line, calendar note; "Other" row with a field when `allowOther` | enabled after one pick (or the minimum) |
| text | one line field, `lineLimit(1...4)` | required: non-empty |
| number | `keyboardType(.decimalPad)`, number formatter | required: a number |
| phone | `telephoneNumber`, `.phonePad`; valid: 7 to 40 of digits, space, + ( ) - . ; error "Enter a phone number with at least 7 digits." | on blur and submit |
| email | `emailAddress`, `.emailAddress`, no autocapitalization; valid: one @ and a dot after it; error "Enter an email address like name@example.com." | on blur and submit |
| date | a compact `DatePicker` (date only); value YYYY-MM-DD; error only when `help` names a limit and the date breaks it | on submit |
| name | First (`givenName`), Middle (`middleName`, optional), Last (`familyName`); error "Enter a first and a last name." | on submit |
| address | Street (`streetAddressLine1`), Apt or unit (`streetAddressLine2`, optional), City (`addressCity`), State or region (`addressState`), Postal code (`postalCode`), Country (a picker, default from the locale, ISO code sent); error "Enter the street, city, state, and postal code." | on submit |
| contact | Name, Phone, Relationship (optional); error "Enter a name and a phone number." | on submit |
| submitting | fields disabled, button "Sending…" | disabled |
| answered receipt | the title, then label and value rows (`AnswerSummary`); when saved: "Saved to your details: Phone" with "Undo" | none |
| answered by chat | "Answered in the chat." then the answer line from `ThreadQuestion.answer` | none |
| dismissed or superseded | one line "No longer needed." in tertiary | none |
| skipped (chat `ask_form` only) | "Skipped." one line | none |
| save failed | the card stays; a red line "The answer did not send. Try again." | enabled |

"Skip" shows only for chat `ask_form`. A runner question has no skip; the user can
answer in the composer instead. A field error shows under its field in red `.caption`.

### 5.3 Page sheet

| State | Dot | Status line | Trailing button | Detent |
|---|---|---|---|---|
| opening | accent-2 | "Opening the shared browser…" | none | medium |
| Albatross has the page | accent-2 | the session detail, else "Albatross has the page." | "Take over" | medium |
| your turn | accent | the handoff detail, else "Your turn on the page. Press Continue when you are done." | `next.label`, else "Continue" | large |
| took over | accent | "You have the page. Press Continue when Albatross should go on." | "Continue" | large |
| checking | accent-2 | "Albatross checks the page…" | disabled | unchanged |
| closed | none | "The page is closed. Press Continue. Albatross opens a new one when the step needs it." | "Continue" when a handoff waits | medium |
| error | none | "The page could not load. Open the site in Safari." with "Open in Safari" | "Close" only | medium |
| user owned (from the plan sheet) | accent | "Your turn on the page. Albatross follows along." | none (the done label resumes the run) | large |
| user owned, verified | green | "Verified. The step is checked off." | none | large |

### 5.4 Thread

| State | Rule | Plan line | Last item |
|---|---|---|---|
| planning | no steps yet | "Albatross makes the plan" | the outcome block |
| needs answers | the newest run is `needs_answer`, or a pending Work question exists | "Step n of m · Needs an answer" | the form |
| ready | a current step is runnable and no run is open | "Step n of m" | the outcome block or the last message |
| running | `activeRun` is open | "Step n of m · Albatross works" | the run block |
| waiting | the newest run is `your_turn` or `ready_for_you` | "Step n of m · Your turn" or "· Ready for you" | the handoff block |
| done | every step done or state `done` | "Done" | the done block |
| put down | state `paused` or a dormant horizon | "Put down" or the horizon line | unchanged |

## 6. Data flow on iOS

### 6.1 Reads

- On open, three reads in parallel: `GET /api/chats?id=work-<workId>` (restore), `GET
  /api/albatross/work/<workId>/runs` (newest 30), and `work_home` (steps, runnability,
  `activeRun`, contract, proof). The cached `WorkDetail` draws first.
- While a run is open (`queued` or `running`), or while a chat turn streams an
  `albatross_handle_step` row, the thread reads the runs every 3 s. The poll stops when the run
  ends, the view goes away, or the scene is not active. `work_home` is re-read when a run ends,
  so the plan line and the step checks settle.
- Otherwise the runs are re-read on appear, on scene active, after every action (start, stop,
  resume, dismiss, answer), and on `workRefreshToken` (a push for this Work).
- The page sheet keeps the Convex subscription `albatrossBrowserSessions:activeSessionForWork`
  as `StepRunBrowserSheet` does today. iOS does not subscribe to `runsForWorkHistory`.

### 6.2 The merge

`ThreadTimeline.merge` follows `mergeThreadTimeline`:

- A message's time is `metadata.createdAt` (ms). A message without it sorts before every run and
  keeps its order.
- A run sorts by `createdAt`.
- `startedRunIds(message)`: the run ids of `albatross_handle_step` rows whose shape is
  `step_run` with action `started` or `resumed`. Those runs render inside the message. A
  `steered` action renders a one-line receipt in the message; the run stays where it is.
- A run with a `parentRunId` that is in the list renders as a continuation (`continues`).
  `RunChainView` draws it inside the parent's block.
- The outcome block is always item zero.

### 6.3 Message metadata

- `AssistantChatModel.apply(event:)` reads the `start` chunk's `messageMetadata.createdAt` and a
  `message-metadata` chunk, and stores it on the assistant message.
- A user message gets `metadata.createdAt = now` when it is created. `transcriptJSON` writes
  `metadata` and `message(from:)` reads it.
- `persistTranscript` posts the whole transcript as today. The server merges by message id.

### 6.4 Answers

- A runner question: `POST /api/albatross/work/questions/<id>/answer` with
  `{ form: FormAnswer, timezone }`. The card shows "Sending…". On 2xx the card becomes its
  receipt and the runs are re-read at once; the resumed run appears as a continuation. On error
  the card stays with the red line.
- A chat `ask_form`: `answerQuestion(id, output: FormAnswer JSON)` resumes the turn; the server
  saves bound values when `save` is true.
- "Skip" sends `{ values: {}, save: false, skipped: true }`.

### 6.5 Personal details

- `PersonalDetailsStore` reads `GET /api/personal-details` on thread open and when a form
  arrives, with a 60 s cache. `prefill(form:)` fills empty bound fields and marks the source line.
- The settings page uses `PUT` for each key and `DELETE` for each key. A 4xx with the refused
  code shows "Albatross does not keep this number here."
- `personal_details_saved` shape: the receipt card. "Undo" restores the previous value from the
  store's cache with `PUT`, or deletes the key when there was none.

### 6.6 Actions

- "Handle it": `POST …/run { action: 'start', stepKey }`. The queued block draws at once.
- "Stop" and "Take over": `cancel`. "Continue", "I signed in", "I paid": `resume`. "Dismiss":
  `dismiss`. All through the existing `ProductStore` calls, then a runs re-read.
- "Mark done" in the menu: `updateWorkState("done")`. "Put it down": `paused`. "Pick it up":
  `active`. "Archive": `archived` behind a confirmation, then pop.

## 7. Accessibility, iPad, dark mode

### 7.1 VoiceOver

- Order: back, the principal button (title, plan line, hint "Opens the plan"), the menu, then
  the items oldest to newest, then the "Newest" pill when present, then the composer.
- The outcome block is one container. Each step row reads "Step 1, Register for the course,
  your turn. Handle it, button."
- A run block is one container with a header element: "Albatross works on Register for the
  course. Newest: Opened the class list. Started by you." Log lines are separate elements under
  it. The Stop button is last.
- Announcements through `PlatformAccessibility.announce`, once for each state change, never for
  each log line: "Albatross started on Register for the course.", "Your turn: Sign in to
  aliveat25.com.", "Albatross asks: Which class?", "Step done: Register for the course.", "This
  run did not finish."
- A form field has a label, a value, and a hint. An option reads "Monday, October 19, 4 to 8 PM,
  Zoom, 70 dollars. Free on your calendar." The calendar note is part of the option label, not a
  separate element. The error line is an element with the field.
- The page sheet's status line is one element with the dot hidden. The web view keeps its own
  accessibility tree.

### 7.2 Dynamic Type and iPad

- Up to AX5: the principal button shows the plan line only; the Work title lives in the outcome
  block. Option rows stack label, detail, and note. Button rows use `ViewThatFits` and fall to a
  vertical stack. The log time column hides and the time becomes a trailing line. The page sheet
  status line wraps to two lines, then truncates.
- iPad, regular width ≥ 900 pt: the page opens as an inspector (`.inspector`) beside the
  conversation instead of a sheet, with the same status bar and buttons (`PagePaneView`). The
  plan and details sheets stay sheets. The thread column keeps a readable measure (max 720 pt
  for text).
- iPad, compact width: the iPhone layout.

### 7.3 Reduced motion and dark mode

- `RevealDot` already stops its pulse under reduce motion. The log collapse, the "Newest" pill,
  and the outcome crossfade use no animation under reduce motion.
- Surfaces: the thread on `paperColor`; user bubbles, run blocks, form cards, and receipts on
  `elevatedColor` with `surfaceCard`; the log well on `subtleColor`. Dark mode elevates by
  lightness and hairline, no shadow, as `Surface.swift` does.
- Colour voice: the accent for the current step and "Your turn"; accent-2 for "Albatross has the
  page"; red for errors and calendar conflicts; green only for the done check. No other colour.

## 8. ASCII wireframes

### 8.1 The thread with a running run

```
┌──────────────────────────────────────────────┐
│ ‹        Register for the Alive at 25 …   ⋯  │
│          Step 1 of 2 · Albatross works       │
├──────────────────────────────────────────────┤
│ Register for Alive at 25 before Nov 2        │
│ Course at aliveat25.com must be finished     │
│ before the November 2 court appearance.      │
│ ● 1 Register for the course · Albatross works│
│   2 Attend the court appearance · You        │
│                                              │
│                         ┌──────────────────┐ │
│                         │ go ahead and     │ │
│                         │ register me      │ │
│                         └──────────────────┘ │
│ Started on the step                          │
│ ┃ ◉ Working on: Register for the course      │
│ ┃   Started by you · 9:40                    │
│ ┃   9:40  Opened aliveat25.com               │
│ ┃   9:41  Read your details: name, email,    │
│ ┃         address                            │
│ ┃   9:41  Found 3 classes before November 2  │
│ ┃   Show all 6 lines                         │
│ ┃   Albatross is on the page · aliveat25.com │
│ ┃                                      Open  │
│ ┃                                      Stop  │
│                                              │
│                                    [Newest]  │
│ ┌──────────────────────────────────────────┐ │
│ │ (clip)  Write to Albatross     Ask  (up) │ │
│ └──────────────────────────────────────────┘ │
└──────────────────────────────────────────────┘
```

"(clip)" marks the existing attach control and "(up)" the send control. "Ask" is the route
chip. The "Newest" pill shows only when the user reads above the bottom.

### 8.2 The S9 and S10 form

```
│ ┃ Albatross needs one answer                 │
│ ┃ I found three classes before November 2.  │
│ ┃ I did not pick one. Your calendar is free │
│ ┃ on two of them.                           │
│ ┃ ┌────────────────────────────────────────┐│
│ ┃ │ Which class?                           ││
│ ┃ │ ◉ Monday, October 19                   ││
│ ┃ │   4:00–8:00 PM · Zoom · $70            ││
│ ┃ │   Free on your calendar                ││
│ ┃ │ ○ Wednesday, October 21                ││
│ ┃ │   4:00–8:00 PM · Zoom · $70            ││
│ ┃ │   Conflicts with Team sync             ││
│ ┃ │ ○ Saturday, October 24                 ││
│ ┃ │   9:00 AM–1:00 PM · Zoom · $70         ││
│ ┃ │   Free on your calendar                ││
│ ┃ │                                        ││
│ ┃ │ Your details for the form              ││
│ ┃ │ Name                                   ││
│ ┃ │ Sam Rivera                             ││
│ ┃ │ From your account                      ││
│ ┃ │ Email                                  ││
│ ┃ │ sam.rivera@example.com                 ││
│ ┃ │ From your account                      ││
│ ┃ │ Home address                           ││
│ ┃ │ 12 Elm Street, Apt 3, Springfield, NY    ││
│ ┃ │ 62704                                  ││
│ ┃ │ From your details                      ││
│ ┃ │ Phone                                  ││
│ ┃ │ [ (555) 010-0100                     ] ││
│ ┃ │                                        ││
│ ┃ │ Save to my details              [ on ] ││
│ ┃ │ Albatross uses saved details in later  ││
│ ┃ │ forms.                                 ││
│ ┃ │                             [Continue] ││
│ ┃ └────────────────────────────────────────┘│
│ ┃ Dismiss                                    │
```

### 8.3 The S13 final-page handoff

```
│ ┃ Your turn · Started by you · 9:52          │
│ ┃ I filled in the form for Monday, October  │
│ ┃ 19 with your name, email, phone, and      │
│ ┃ address.                                  │
│ ┃ Everything is filled in. Check it and pay │
│ ┃ the $70.                                  │
│ ┃ Registration form · Page                  │
│ ┃ What I did                              › │
│ ┃ [Check and pay]  [I paid]                 │
│ ┃ Dismiss                                   │
```

### 8.4 The page sheet

```
┌──────────────────────────────────────────────┐
│ Close         aliveat25.com          I paid  │
│               Register for the course        │
├──────────────────────────────────────────────┤
│ ● Everything is filled in. Check it and pay  │
│   the $70.                                   │
├──────────────────────────────────────────────┤
│                                              │
│   [ the live remote page ]                   │
│   Reserve a Spot                             │
│   First name   Sam                           │
│   Last name    Rivera                        │
│   Street       12 Elm Street Apt 3           │
│   …                                          │
│   [ Pay $70 ]                                │
│                                              │
└──────────────────────────────────────────────┘
```

While Albatross has the page the trailing button reads "Take over" and the sheet sits at
medium with the thread visible behind it.

### 8.5 Personal details settings and the editor

```
┌──────────────────────────────────────────────┐
│ ‹ Settings        Personal details           │
├──────────────────────────────────────────────┤
│ Albatross types these into forms when a      │
│ step needs them.                             │
│                                              │
│ Name                 Sam Rivera            › │
│                      From your account       │
│ Email                sam.rivera@example.com› │
│                      From your account       │
│ Phone                (555) 010-0100        › │
│                      You told Albatross on   │
│                      Oct 7                   │
│ Home address         12 Elm Street, Apt 3, › │
│                      Springfield, IL 62704     │
│                      You saved this on Oct 7 │
│ Emergency contact    Add                   › │
│                                              │
│ OTHER DETAILS (sentence case: Other details) │
│ Add a detail                               › │
│                                              │
│ Albatross never saves passwords, card        │
│ numbers, or ID numbers here. Delete any      │
│ detail at any time.                          │
└──────────────────────────────────────────────┘

┌──────────────────────────────────────────────┐
│ Cancel            Phone                Save  │
├──────────────────────────────────────────────┤
│ Phone                                        │
│ [ (555) 010-0100                           ] │
│ Forms get this number. Albatross asks        │
│ before it saves a new one.                   │
│                                              │
│ You told Albatross on Oct 7.                 │
│                                              │
│ Delete                                       │
└──────────────────────────────────────────────┘
```

The section header is "Other details" in sentence case; the wireframe note only marks the
place. The Name editor adds the line "Your account says Sam rivera. Forms use what you save
here." and a "Use the account name" control.

## 9. Open questions for the lead designer

1. **List, practice, and milestone shapes.** The thread is the Work page for every shape. The
   shape body (items, metric, milestones) moves to the details sheet, and the outcome block shows
   a three-line summary with "Open". Recommendation: do this in PR 1 and watch dogfood. If a
   list needs its items on the page, add a "List" segment later.
2. **"Working on:" is an -ing form.** The brief uses it. STE forbids -ing verbs. Recommendation:
   keep the brief's words in PR 1 for parity with web and Mac, and decide one form for all three
   platforms before release. The candidate is "Now: Register for the course".
3. **Where "Personal details" sits in Settings.** Recommendation: Account, under Connections.
   It is identity data, and "From your account" rows point there. The Trust footer names it.
4. **"Handle it" through the chat agent or through the run route.** Recommendation: the button
   posts `start` directly. No model turn, no cost, and the block draws at once. The written
   request ("go ahead") goes through the agent.
5. **Skip on runner questions.** Recommendation: no skip. The run waits; the user answers in the
   form or in the composer. "Dismiss" on the block closes the handoff when the user does not want
   the run at all.
6. **The second button on `finish_on_page`.** The contract gives one `next.label`. S13 wants
   "Check and pay" (open the page) and "I paid" (resume). Recommendation: the server adds
   `next.doneLabel` ("I paid", "I signed in"). Until then iOS shows `next.label` and "Continue".
7. **Convex live runs on iOS.** Web and Mac subscribe to `runsForWorkHistory`. Recommendation:
   iOS polls at 3 s in PR 1, as the step runner does today, and moves to the subscription when
   the Convex client's reconnect behaviour on iOS is proven.
8. **Older chats.** Recommendation: a row in the details sheet, read-only. No merge control.
9. **iPad inspector.** Recommendation: build the inspector in PR 1 only if the Mac pane and the
   inspector share `PagePaneView`. Otherwise the iPad uses the sheet in PR 1.
10. **The "Newest" pill versus Perplexity's round control.** Recommendation: a text pill. No icon
    before text, and it reads as a verb for VoiceOver.

## 10. Copy table

| Place | Line |
|---|---|
| plan line, planning | "Albatross makes the plan" |
| plan line, ready | "Step 1 of 2" |
| plan line, running | "Step 1 of 2 · Albatross works" |
| plan line, your turn | "Step 1 of 2 · Your turn" |
| plan line, needs answer | "Step 1 of 2 · Needs an answer" |
| plan line, ready for you | "Step 1 of 2 · Ready for you" |
| plan line, done | "Done" |
| plan line, paused | "Put down" |
| outcome block, planning | "Albatross makes the plan." |
| outcome block, step state | "Albatross can handle it", "You", "Albatross works", "Your turn", "Done" |
| run header, open | "Working on: {step}" |
| run line, queued | "Waiting to start." |
| run line, steer | "Read your note: {note}" |
| run row, page | "Albatross is on the page · {host}" / "Open" |
| run header, needs answer | "Albatross needs one answer" |
| run header, your turn | "Your turn" |
| run header, ready | "Ready for you" |
| run header, done | "Done · Verified on the page" (or the verification label) |
| run header, failed | "This run did not finish." |
| run header, cancelled | "Stopped by you." |
| run header, dismissed | "Dismissed." |
| run header, limit | "Albatross stopped at its time limit." / "…cost limit." |
| run rule, chain | "Continued · {time}" |
| run buttons | "Handle it", "Stop", "Continue", "Try again", "Dismiss", "Mark this step done", "Read and send", "Open the document", "Approve the invite", "Open", "Sign in", "Check and pay", "I paid", "I signed in" |
| form, details section | "Your details for the form" |
| form, source lines | "From your account", "From your details", "From your email signature" |
| form, save toggle | "Save to my details" / "Albatross uses saved details in later forms." |
| form, submit | `submitLabel` or "Continue" / "Sending…" |
| form, skip (chat only) | "Skip" |
| form, receipts | "Answered in the chat.", "No longer needed.", "Skipped." |
| form, errors | "The answer did not send. Try again.", "Enter a phone number with at least 7 digits.", "Enter an email address like name@example.com.", "Enter a first and a last name.", "Enter the street, city, state, and postal code.", "Enter a name and a phone number." |
| details receipt | "Saved to your details: {labels}" / "Undo" / "Removed from your details: {labels}" |
| page sheet | see section 5.3 |
| sign in handoff | "Sign in to {host} in the page, then press Continue." |
| final page handoff | "Everything is filled in. Check it and pay the ${amount}." |
| menu | "Details", "Split…", "Put it down", "Pick it up", "Set horizon…", "Mark done", "Archive…" |
| composer placeholder | "Write to Albatross" |
| newest pill | "Newest" |
| settings row | "Personal details" |
| settings intro | "Albatross types these into forms when a step needs them." |
| settings footer | "Albatross never saves passwords, card numbers, or ID numbers here. Delete any detail at any time." |
| settings sources | "From your account", "You saved this on {date}", "You told Albatross on {date}", "From a form on {date}" |
| settings, missing | "Add" |
| settings, custom section | "Other details" / "Add a detail" |
| editor, name | "Your account says {account name}. Forms use what you save here." / "Use the account name" |
| editor, phone help | "Forms get this number. Albatross asks before it saves a new one." |
| editor, refused | "Albatross does not keep this number here." |
| editor, delete | "Delete" |
| older chat banner | "An older chat about this Albatross. Write in the Albatross to continue." |
| offline | "Showing the last saved conversation." |
