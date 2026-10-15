# Goal runs, native design note (2026-10-15)

Status: approved with changes on 2026-10-15 (section 12), in build. Branch `claude/goal-runs-native`,
worktree `/home/jjalangtry/repos/lab86-goal-native`, base `e235d027`.

The brief is `docs/albatross-goal-runs.md` (owner decisions D1 to D3 are final). The wire shapes are
`lib/albatross/goal-run-contract.ts` and `lib/shared/types.ts` (`DraftAttachment`). Swift mirrors
those names. This note keeps every decision of the thread, threads, document handoff, and blank
notes. It adds only what a goal run needs: talk with sources, the checklist, the package, document
mode with several items, draft attachments, saved files, and sealed fields.

Sample data is invented. The Work is "Bill Harbor Design for the quarter". The user is Sam Rivera.
The client contact is Priya Shah at `harbordesign.example`. The hours are 36, 52, and 41. The rate
is $95. The Jira key is `HD-214`. No real person and no real number from a dogfood run appears here.

## 0. What the code does today (mapped 2026-10-15)

- `Core/Models/StepRunModels.swift`: `StepRunView` decodes `next`, `artifacts`, `log`, and the
  run words. It has no `goal`, `messages`, `checklist`, `items`, or `unsure`. `Artifact.Kind` has
  no `deck` and no `file`. Unknown enum words decode as `.unknown` (the pattern this note keeps).
- `Features/Work/RunBlockPresentation.swift:206`: `ThreadState.resolve` returns `.planning` when
  `guideSteps` is empty. A goal Work has zero steps, so the plan line reads "Albatross makes the
  plan" forever, and `OutcomeBlockView` shows the same line with a live dot.
- `Features/Work/WorkThreadModel.swift:352`: `handle(step:)` calls
  `store.start(stepKey: step.id, ...)`. "Handle it" lives only on a step row
  (`OutcomeBlockView.stepRow`, `PlanListView.row`). A goal Work has no row, so it has no button.
- `Core/Models/WorkThreadStore.swift:89`: `start` always sends `stepKey`.
- `Features/Work/RunBlockView.swift`: the header draws `run.stepTitle` as its second line. For a
  goal run the step title is the Work title, which the navigation bar already shows.
- `Features/Work/DocumentHandoff.swift` and `WorkThreadModel.document`: document mode opens one
  `DocumentTarget` (an Albatross document or a Word file). No PDF, no deck, no draft.
- `Features/Work/DocumentModeView.swift` (iOS) and `Lab86MailMac/Work/MacDocumentMode.swift`: one
  editor in a `NativeWorkspaceView`, the "your part" card or bar, "Done, continue".
- `Features/Mail/ComposeView.swift`: attachments are local `ComposeAttachment` values with bytes.
  `ComposePrefill` has no server file references. `ProductStore.loadDraftPrefill` reads `to`,
  `cc`, `bcc`, `subject`, and `body` from `list_drafts` and nothing else.
- `Features/Today/ReadyForYouSection.swift` and `MacReadyForYouRow.swift`: the caption reads
  `StepRunCopy.readyRowTitle`, which is the step title. For a goal run that repeats the Work title.
- `Features/Work/ThreadRowPresentation.swift:125`: a row at work with no server preview shows
  `stepTitle`. For a goal run that repeats the row title.
- `Features/Work/PlanSheet.swift` and `DetailsSheet.swift`: the plan is a list of steps. A goal
  Work has none, so the plan sheet is empty and Details has no "Plan" section.
- No file imports `PDFKit`. `FilesView` uses `.quickLookPreview` for a local URL.
  `BackendClient.download(path:)` saves an authenticated download to a protected temporary file.
- The web side: `StepRunView` already carries the five goal fields (`lib/albatross/step-run-fixtures.ts`).
  `DraftAttachment` exists only as a type. The compose route does not read file references yet.
  The tour fixtures (`NativeTourFixtures.json`) serve runs from `scenarios[<id>].paths`.

## 1. Research

### 1.1 Mobbin, iOS

Each row names the screen, what it does, what the design takes, and what it rejects.

| Screen | What it does | Taken | Rejected |
|---|---|---|---|
| [Perplexity, answer with citation chips](https://mobbin.com/screens/fe1aa2bb-e46b-45b2-ac6f-e2cb4916cbf1) | Small grey capsules ("loveandlemons +2") sit in the text after each claim; "10 sources" at the end. | Sources as small text capsules under the message they support. | Chips inside the sentence, and "+2" counts. Ours sit under the text, at most 8, each named. |
| [ChatGPT, Sources sheet](https://mobbin.com/screens/3eaf4e44-fdce-48bc-965b-b194ed9c43ac) | A sheet lists each source: the site, the title, one line. | The source anatomy: a kind word, then the title. | A sheet. A tap on a chip opens the source itself. |
| [Comet, "2 steps completed"](https://mobbin.com/screens/2faad092-c040-40a9-af66-d7426930b2b2) | A folded step count above the answer, domain chips after claims. | The folded count for the tool lines ("What Albatross did 14", as today). | Nothing. |
| [Binance, "Data from binance.com"](https://mobbin.com/screens/328de467-6852-4d42-b971-16e3b5b8f69c) | One source line under the answer, with a logo. | The kind word before the name ("Web · irs.gov"). | The logo. No icons before text. |
| [Beside, "1 sources"](https://mobbin.com/screens/71796e40-c453-4f8d-958c-c4c4109ecd3b) | A count with no names. | Nothing. | A count without names. A source must be named to be opened. |
| [Grok Bot, "Main sources" and a file card](https://mobbin.com/screens/c98bc5c5-565f-402a-b873-b45441e283c4) | Sources as inline links; a handed-over file "week-meal-prep.md · 3.1 KB". | A file the run made is a row with its name and size. | Inline links. Links in body text are hard to tap. |
| [Manus, checklist in the run](https://mobbin.com/screens/5d0f4b76-a8c3-44d5-9ef1-026be6656cbe) | A message, then a card with done items (checks) and the current one (spinner); "Manus will continue after your confirmation". | The checklist inside the run block, with done and current items, and a line for what is the user's. | Check and spinner icons, and the "14 / 50" counter. Ours use a state word column and the live dot. |
| [ChatGPT, research stopped](https://mobbin.com/screens/d046e8d0-2f88-4f1a-a222-b8fd57d5917e) | A stopped run keeps its plan visible with the done and open items. | A stopped run keeps its checklist, so the user sees where it got to. | Circle icons. |
| [Linktree, "Analysis" disclosure](https://mobbin.com/screens/7e370793-4b21-4992-8738-e417d3ce22dc) | Past tool steps fold under one disclosure. | The log stays folded (as today). | -ing step names ("Loading your links"). |
| [v0, talk between tool groups](https://mobbin.com/screens/f4489226-373f-42bf-9839-26105c144eff) | One sentence, then a group of "Read …" rows, then the next sentence. | Talk between groups of tool calls, as the prompt in G2 asks. | Each tool call as a row in the main flow. Ours stay in the folded log. |
| [Monarch, progress checklist](https://mobbin.com/screens/5fa31955-8e9c-4f6e-b7f1-4e4443b098fa) | A full-screen list of -ing phases. | Nothing. | -ing forms and a screen that blocks the app. |
| [Manus, deliverable card](https://mobbin.com/screens/c64c719b-b356-44c9-827b-d7f826cb0201) | A card for the thing made, two verbs, then "Task completed". | One verb on each package row. | The preview image. Our rows are text. |
| [Microsoft Copilot, file chip in the composer](https://mobbin.com/screens/51be7d0c-2c0a-4940-a589-9bc4b2c5e099) | A chip with the name, the type, and a remove control. | The type word on an attachment row. | A chip that floats. Ours is a row under the subject. |
| [Telegram, file row in a chat](https://mobbin.com/screens/dc595580-c846-42cc-8270-b1c9ebb36761) | "IMG_9281.PNG · 15.5 KB". | The size on a file row. | Nothing. |
| [Revolut Business, Preview Invoice](https://mobbin.com/screens/1c6878d2-33ce-4834-9bfd-43d9beec6b59) | A segmented control "PDF, Email, Payment" over the invoice page. | The exact shape of document mode on iPhone: one control over the item, one item at a time. | A segmented control. Item titles are long, so the bar is a row of text capsules (the filter pills of the Work list). |
| [Lloyds, statement "1 of 6"](https://mobbin.com/screens/c35f2604-fc4c-4a3d-a010-08670528d201) | A document with a counter and a download control. | "2 of 3" for VoiceOver on the item bar. | The zoom controls. |
| [Freeform, PDF viewer](https://mobbin.com/screens/a8ab1d82-a65f-4c18-923a-95b118c0177c) | A white page on a flat grey field, the file name in the bar, find and page controls. | The page floats on the paper colour; the item title in the bar. | Find and page buttons. PDFKit scrolls. |
| [Gusto, Form W-4 viewer](https://mobbin.com/screens/7c09304c-6c9d-47d7-81b4-5bb2375259ce) | A tax form in a plain viewer with a share control. | A tax form opens in a plain PDF viewer with the form name as the title. | Nothing. |
| [PayPal, Direct Deposit form](https://mobbin.com/screens/1d780c72-a592-49c0-9c7a-6762f7ee6de8) | A form preview with "Email Your Form" and "Download form". | Two verbs for a saved file: it goes with the draft, or the user downloads it. | A black full-width button. |
| [Turo, Review and submit](https://mobbin.com/screens/7e7fe513-3024-43d1-b185-6bdb0d01231e) | "Other information provided: Last 4 SSN"; "Update W-8/W-9 certification". | A secret shows as a fact that exists, never as its value: "The tax ID fills in when you send." | Nothing. |
| [Obsidian, file list](https://mobbin.com/screens/28e5f5ae-8f3b-4acb-b93a-ac9f192db64e) | A file list beside the open note, with a type caption on each row. | The Mac list of package items with a kind caption. | ALL-CAPS captions. |
| [Microsoft Outlook, compose with attachments](https://mobbin.com/screens/e224f517-7a5a-4e8b-a5f0-ec38c616d8f3) | Rows under the subject: name and size; "Remove Attachment" in a sheet. | Rows under the subject with the name and the size, and Remove. | The action sheet. Remove is on the row. |
| [Jobber, Email invoice](https://mobbin.com/screens/a7401b17-cbff-406d-8f96-bb2a889b3c3f) | Subject, message, "Attachments" with the invoice PDF, "Send Email". | The invoice PDF is an attachment of the draft by default. | A tile grid. |
| [Notion Mail, compose with a PDF](https://mobbin.com/screens/1cc5274b-24b2-4cb0-85f2-1a2f33534da5) | "Overview.pdf · 77 KB" as a card at the bottom. | The size. | A card that floats. |
| [inDrive, receipt](https://mobbin.com/screens/e7ce7ac5-22ca-4d50-9bcf-8aaddf7da919) | A PDF with Download, Share, Mail as icon buttons. | Nothing. | An icon toolbar. Ours are words. |

### 1.2 Mobbin, web (for the Mac)

| Screen | What it does | Taken | Rejected |
|---|---|---|---|
| [Lindy, agent chat with a checklist](https://mobbin.com/screens/9f4affd5-f387-4149-860e-95c83f9bbba5) | Talk, then done items with checks, "Processing…"; a right pane with "Browser" and "Terminal" tabs. | The checklist inside the talk. | Check icons, -ing, and a pane for the tools. |
| [WRITER, "Computer / Deliverables"](https://mobbin.com/screens/9aea1adb-3bb2-447e-86e8-6978fc84ba94) | A "Deliverables" tab lists the files; one opens with Back, Preview, Code. | The package as a list, one item open at a time. | Tabs for the pane. The Mac pane already has its rules. |
| [Grok, Files workspace](https://mobbin.com/screens/d02f5c96-32bc-4494-b11f-ea9f044f1920) | A file list on the left, the document in the center, the chat on the right. | The three-part shape of Mac document mode with the package list. | A list of every file. Ours lists the items of this package. |
| [Obvious, artifact tabs](https://mobbin.com/screens/f4195390-3da9-48d9-8fee-6018513e8153) | "All Artifacts 1 · Q1 Overview" as tabs over the document. | Tabs over the center when the window has no room for the list. | Nothing. |
| [Langdock, canvas](https://mobbin.com/screens/579fb137-50fa-42d0-9222-4970f35648d5) | "Read 'file'" rows, a document card that opens the canvas. | The document card opens document mode (D5, as today). | Nothing. |
| [Mistral Le Chat, canvas](https://mobbin.com/screens/76e16697-0e20-4bfc-8162-e93d6f1fc8ff) | An artifact card "Text · Modified" beside the talk. | The kind word and the state word on a package row. | Nothing. |
| [Dropbox Dash, sources](https://mobbin.com/screens/09e3f23a-6afc-46b2-8079-2e20a8b8c879) | "Attach sources", a PDF source card, the document on the right. | Sources named next to the talk. | Nothing. |
| [Zapier Central, "Action Complete"](https://mobbin.com/screens/cb65c41e-e7b6-4bd9-af40-cd92d768e90d) | One card line for each thing made ("Gmail: Create Draft"). | One line for each made thing, with its kind. | The expand control. |
| [Google Gemini, "Thinking steps" pane](https://mobbin.com/screens/19fa8a36-4f95-4ea2-ad23-533e31965ddb) | A separate pane for the steps. | Nothing. | A pane for the steps. The checklist stays in the thread. |

### 1.3 Apple guidance

- Sidebars (HIG): a list of items in a leading column with a persistent selection. Decision: the
  Mac package list is a leading column in document mode, with the system selection fill.
- Segmented controls (HIG): best with up to five short segments. Decision: item titles are long,
  so the iPhone bar is a row of text capsules (the Work list pills), not a segmented control.
- Inspectors (HIG) and PR 1 decision 14: one trailing pane. Decision: the package list is not an
  inspector. It is part of the document stage, so the trailing pane rules do not change.
- PDFKit: `PDFView` exists on iOS and macOS. `autoScales`, vertical direction, continuous pages.
  Decision: saved PDF files open in a native `PDFView`, read-only.
- Lists (HIG): keep item text short; give feedback on selection. Decision: package rows are
  two lines, and the selected item carries the fill in the Mac list.

## 2. User stories

Platforms: I (iPhone and iPad), M (macOS). The web has the same list.

- **G1. Watch a run (I M).** Sam presses "Handle it" on "Bill Harbor Design for the quarter". A run
  block appears: "In progress", then "Now: Find the hours for each month". Under it, Albatross
  writes: "I look for the hours in your mail and in Jira first." A minute later: "Jira shows 36,
  52, and 41 hours. No mail names the hours, so I use Jira." Each message has its sources under it.
- **G2. Open a source (I M).** Sam taps "Jira · HD-214 worklog". The issue opens in the browser.
  Sam taps "Mail · Re: Q3 hours from Priya Shah". The mail thread opens in the app.
- **G3. Read the checklist (I M).** The block shows "Checklist · 2 of 6 done". Sam opens it: "Done
  Find the billing address", the live dot and "Find the hours for each month", "Make the invoice",
  "Get the W-9 from irs.gov", "You Sign the W-9", "Write the mail to Priya Shah". Sam opens the
  same list from the line under the title, and in Details.
- **G4. Open each package item (I M).** The run ends: "Ready for you". The package lists "Draft to
  Priya Shah" (Check it, 2 files attached), "Invoice 2026-10 for Harbor Design" (Fill in hours for
  September and hourly rate), and "Form W-9" (Check it; the tax ID fills in when you send). Sam
  taps the invoice. Document mode opens on the invoice, with the three items in the bar.
- **G5. Fill invoice blanks (I M).** The Word editor shows the invoice. The bar reads "Fill in
  hours for September and hourly rate." Sam types them. On the iPad and the Mac, the thread
  column stays open; Sam writes "use 41 for September" and the document updates. "Done, continue"
  closes document mode.
- **G6. Check a W-9 with a sealed tax ID (I M).** Sam switches to "Form W-9". A PDF shows, with the
  tax ID field empty. Under it: "The tax ID fills in when you send or download." Sam presses
  "Open on the web" for the download with the identity check. On the Mac, the same line and the
  same button sit under the PDF.
- **G7. Send the draft with attachments (I M).** Sam presses "Read and send". The composer opens
  with "Invoice 2026-10.pdf · PDF · 84 KB" and "Form W-9.pdf · PDF · The tax ID fills in when
  you send." as rows under the subject. Sam removes nothing and presses Send. The server reads
  the bytes and fills the tax ID at send time.
- **G8. Steer (I M).** While the run works, Sam writes "bill the September hours at $110". The note
  goes to the run (T7). The next message reads: "I set September at $110, as you said." The
  checklist item "Make the invoice" goes back to the live dot.
- **G9. A run that stops at its limit (I M).** The run reads "Stopped · Albatross stopped at its
  time limit." The checklist shows 4 of 6 done. The block offers "Continue". The block shows no
  "Handle it". Sam presses "Continue"; a new block reads "Continued · 10:12" and goes on from the
  checklist.
- **G10. An old step Work (I M).** Sam opens "Register for the CPR and first aid course" from
  last week. The plan rows, "Step 2 of 4", the step blocks, and "Mark step done" look as before.
  No message, checklist, or package appears, because the runs have none.

## 3. Layouts for each run state

The run block keeps its spine (the 2 pt rail, the header, the body, the quiet "Dismiss"). A goal
run adds four parts: messages with sources, the checklist, the package, and "Not sure". Every part
draws only when its array is not empty, so an old step run draws as today.

### 3.1 The header of a goal run

```
● In progress · Started by you          ← headline + trigger, as today
  Now: Find the hours for each month    ← the `doing` item, not the step title
```

- Line 2 is `RunBlockCopy.subtitle(run)`: for a goal run at work, "Now: {first doing item}";
  with no doing item, nothing. For a goal run that ended, nothing. For a step run, the step title
  as today. The Work title never repeats inside the block.

### 3.2 An open goal run (queued, running)

iPhone:

```
● In progress · Started by you
  Now: Find the hours for each month
  I look for the hours in your mail and in Jira first.
  [Mail · Re: Q3 hours]  [Jira · HD-214]
  Jira shows 36, 52, and 41 hours. No mail names the hours,
  so I use Jira.
  [Jira · HD-214 worklog]
  Earlier messages  4                     ← disclosure, only when more than 3
  Checklist · 2 of 6 done                 ← disclosure, open on the newest run
     Done   Find the billing address
     ●      Find the hours for each month
            Make the invoice
            Get the W-9 from irs.gov
     You    Sign the W-9
            Write the mail to Priya Shah
  What Albatross did  14                  ← the log, folded, as today
  Albatross is on the page · irs.gov                     Open
                               [Stop and redirect] [Stop]
```

- Messages: the newest three in full, `.body`, no bubble, no time. Albatross is one voice; its
  run messages read like its chat messages. Older ones fold under "Earlier messages" with the
  count as a quiet number. The row keeps the newest 40; the client shows what it gets.
- Sources: a wrap row of text capsules under the message, `.caption`, `.bordered` style with the
  small control size. Label: "{kind word} · {title}", one line, tail. At most 8. Reduce Motion
  changes nothing. VoiceOver: "Source. Jira. HD-214 worklog. Button."
- With no messages yet, the open body shows `progressLine` as today. The log well of today
  (the newest three log lines) draws only for a run with no messages, so a goal run does not show
  the log twice.
- Checklist: a `DisclosureGroup`. The label reads "Checklist · {done} of {count} done"; with a
  `yours` item, "Checklist · 2 of 6 done · 1 for you". It is open on the newest run and closed on
  older blocks. Rows use the plan-row grammar: a 38 pt leading column with "Done" (green),
  the `RevealDot` for `doing`, "You" (accent-3) for `yours`, nothing for `todo`; then the text,
  `.subheadline`, strikethrough when done. No check icons.
- The page row, "Stop and redirect", and "Stop" stay as today.

iPad: the same block at the thread's width. Mac: the same block at the reading measure; chips
show the full title and the URL in `.help`; the checklist rows and the chips take the hover fill.

### 3.3 A goal handoff with a package (ready_for_you, your_turn)

iPhone:

```
Ready for you · Started by you
  The invoice, the W-9, and the mail to Priya Shah are ready.
  I set September at $110, as you said.          ← the newest message
  Earlier messages  11
  ┌──────────────────────────────────────────────────┐
  │ Draft to Priya Shah                 Read and send │
  │ Check it · 2 files attached                       │
  │──────────────────────────────────────────────────│
  │ Invoice 2026-10 for Harbor Design            Open │
  │ Fill in ______ and ______.                        │
  │         hours for    hourly rate                  │
  │         September                                 │
  │──────────────────────────────────────────────────│
  │ Form W-9                                     Open │
  │ Check it · The tax ID fills in when you send.     │
  └──────────────────────────────────────────────────┘
  Not sure
  I found no mail with the hours for July. I used 36 from the Jira worklog.
  Checklist · 6 of 6 done
  What Albatross did  31
  [Read and send]  [Done, continue]
  Dismiss
```

- Order: the summary, the newest message, "Earlier messages", the package, "Not sure", the
  folded checklist, the folded log, the buttons, "Dismiss". This is the brief's order with the
  summary first, because the summary is the server's final word.
- The package is one `surfaceCard` with one row for each item (max 8). Row line 1: the title
  (`.subheadline`) and the verb at the trailing edge (`.borderless`, medium weight). Line 2 by
  state: `ready` reads "Ready"; `blanks` draws `BlankSentence(size: 15)` with the item's blanks;
  `check` reads "Check it", then " · " and the note when there is one. A `ready` item with a note
  reads the note alone. The whole row is a button; the verb is the same action.
- Verbs by kind: draft "Read and send"; document, sheet, deck, file "Open"; approval "Approve";
  event "Open"; page "Open the page"; unknown "Open".
- With items, the block does not draw `next.blanks` as the top sentence. The rows carry the
  blanks. `next.detail` still shows under the summary when the server sends it.
- "Not sure": a section title in the Details style (`.footnote`, semibold, secondary), then each
  line in `.subheadline`. At most 4. Nothing draws when the array is empty.
- The buttons follow `RunBlockHandoffAction` as today: the main button is `next.label`; "Done,
  continue" sits beside it on a `ready_for_you` or `your_turn` goal handoff. It tells Albatross
  that the user did their part; the server records it and queues a goal run that checks the
  outcome contract. On a step run the second button still reads "Mark step done". With no items
  and no `next`, a goal handoff shows "Continue" (a resume), never a one-tap close of the Work.
- `needs_answer` keeps its form. A goal run with a question draws the messages, then the form,
  then the folded checklist. No package.

Mac: the same block. Package rows take the hover fill and a context menu with the verb and
"Copy the title". The chips and the rows are in the Tab order.

### 3.4 Stopped at a limit, done, failed, cancelled

- Stopped: the limit line, the summary, the newest message, the package when the run made one,
  the checklist open (the user wants to see where it got to), the log folded, "Continue",
  "Dismiss". No "Handle it" on the block (G6). The outcome block offers no "Handle it" while the
  newest run waits, because `ThreadState` reads `.readyForYou`.
- Done: "Done · {contract word}" in green, the summary, the newest message, the package rows as
  a quiet list (no card, the Details "Files" style), the checklist folded, the log folded.
- Failed: the error in red, the newest message when there is one (it may say why), the
  checklist folded, the log folded, "Try again". "Try again" starts a goal run again.
- Cancelled: the summary, the checklist folded, the page row, "Continue".
- Closed (dismissed): one quiet line, as today.

### 3.5 The outcome block and the plan line of a goal Work

- A goal Work (`isGoalWork`) draws the title, the summary, the shape line, and then one row with
  "Handle it" (prominent, small) when `threadState.offersHandleIt`. No step rows. No "Albatross
  makes the plan" row. The checklist does not repeat here; the newest run block and the sheet
  show it.
- The plan line under the title: no step position. `.ready` reads "Ready"; `.running` reads
  "Albatross works on it"; the handoff words as today; `.done` "Done"; `.putDown` "Put down".
- A tap on the plan line opens the Checklist sheet (iPhone) or the Checklist popover (Mac) in
  place of the plan. The sheet title is "Checklist". With no run yet it reads "No checklist yet.
  Albatross writes one when it starts." The footer reads "Albatross keeps this list while it
  works. Tell Albatross in the conversation when something changed."
- Details: for a goal Work, a "Checklist" section replaces the "Plan" section. It shows the
  newest run's checklist in the same rows. "Files" lists every artifact as today, and a `file`
  or `deck` artifact opens like its package item.

### 3.6 Document mode with several items

iPhone (full-screen cover, as today):

```
[Draft to Priya Shah] [Invoice 2026-10] [Form W-9]     ← capsule bar, scrolls
┌──────────────────────────────────────────────────┐
│ the item: Word editor, PDF page, deck, or draft   │
└──────────────────────────────────────────────────┘
Fill in ______ and ______.                           ← the bar: this item's blanks
[Done, continue] [Chat]
```

- The bar: `DocumentModeItemBar`, a horizontal row of text capsules, the selected one with the
  `accentSoftColor` fill, under the top safe area. One capsule per item (kinds draft, document,
  sheet, deck, file). Approval, event, and page items are not tabs; they open where they open
  today. With one item the bar does not draw, so an old handoff looks as today.
- VoiceOver on a capsule: "{title}. Tab 2 of 3." A swipe between items is not added; the capsules
  are the control.
- The bottom bar shows the blanks of the selected item (`item.blanks`), else the handoff's
  `next.blanks` or `next.detail` as today. "Done, continue" keeps its meaning (D3). A `file` item
  with sealed fields adds the line "The tax ID fills in when you send or download." and the
  button "Open on the web".
- The item views:
  - document, sheet: `NativeWorkspaceView` with `DocumentTarget.workspaceDestination`, as today.
  - deck: `NativeWorkspaceView` with `NativeWorkspaceDestination.document(id)`. A deck is an
    Albatross document with the deck kind (open question 5).
  - file (PDF): `SavedFilePDFView`, a native `PDFView`. Other content types (DOCX, XLSX, PNG) use
    `.quickLookPreview` on the downloaded URL, as Files does.
  - draft: `DraftItemView`: To, Subject, the body read-only, the attachment rows, and "Edit and
    send", which opens the composer with the attachments (G7). The chat column stays usable.
- The chat context: the `document` attachment follows the selected item when it is a document,
  a sheet, or a deck. A file or a draft tab sends no document attachment (open question 6).

iPad: the editor on the left with the capsule bar above it, the thread column on the right with
the "your part" card for the selected item (as today).

Mac:

```
┌ Package ──────────┐┌ Invoice 2026-10 for Harbor Design · saved        Close ┐┌ thread column ┐
│ Draft to Priya Shah││                                                        ││ Fill in __ and__│
│ Check it           ││              the Word editor (WKWebView)               ││ [Done, continue]│
│ ▸ Invoice 2026-10  ││                                                        ││ Back to thread  │
│ Fill in 2 fields   ││                                                        ││ ─────────────── │
│ Form W-9           ││                                                        ││ transcript      │
│ Check it           ││                                                        ││ composer        │
└────────────────────┘└────────────────────────────────────────────────────────┘└─────────────────┘
```

- `MacPackageList`: a leading column (min 200, ideal 240, max 300 pt) inside `MacDocumentSplit`,
  only when the set has more than one item. A `List(selection:)` with two-line rows: the title,
  then the state line ("Ready", "Fill in 2 fields", "Check it"). The selected row carries the
  system fill. Arrow keys move the selection (system). No new shortcuts (HIG: add shortcuts only
  when necessary). The View menu gains "Next Item" and "Previous Item" as plain buttons without
  keys, dimmed when one item or no document is open.
- Room: the list needs 200 pt more. `MacThreadLayout.documentRoom` learns the list width. When the
  window has no room for the list, the dock header shows the items as text capsules over the
  editor (the Obvious pattern), and the list hides.
- The dock header title is the selected item's title. "Close" closes document mode, as today.
- The "your part" card shows the selected item's blanks or note, with "Done, continue" and
  "Back to thread". The step label does not draw for a goal run (it would repeat the Work title).

### 3.7 The composer with attachments

iPhone and Mac (`ComposeView`, the same view on both):

```
To       Priya Shah <priya@harbordesign.example>
Subject  Invoice 2026-10 for Harbor Design
──────────────────────────────────────────────────
Invoice 2026-10.pdf                                  Remove
PDF · 84 KB · From Albatross
──────────────────────────────────────────────────
Form W-9.pdf                                         Remove
PDF · The tax ID fills in when you send.
──────────────────────────────────────────────────
Hi Priya, …
```

- Server file references draw as rows in the same style as local attachments: the name on line
  1, then "{format word} · {size} · From Albatross" on line 2. A sealed file reads
  "{format word} · {sealed line}" and no size. Remove takes the row out of the draft; a save
  writes the new list. No row opens the file here; the package and document mode do that.
- Local files and server files can mix. The send posts the local bytes as today and the server
  references as one JSON part (open question 3).
- The inline chat draft (`AssistantDraftArtifactView`) does not change in this round. A run's
  draft opens in the full composer.

### 3.8 The Brief and the thread list

- "Ready for you" rows (`ReadyForYouSection`, `MacReadyForYouRow`): for a goal run the caption
  line does not repeat the Work title. At work it reads "In progress"; after a handoff it reads
  the headline. The row line reads the summary as today, then, when the run has items, one more
  line: "3 items: Draft to Priya Shah, Invoice 2026-10 for Harbor Design, and Form W-9." (the
  first three titles; more than three ends with "and 2 more").
- The thread list row: when the live `stepTitle` equals the row title, the client does not use
  it as the preview. The server's `preview` (the newest message) wins when it sends one (open
  question 7).

## 4. Copy

Sentence case. Simplified Technical English. No -ing forms, no "AI", no icons before text.

| Key | Text |
|---|---|
| `GoalRunCopy.now(_:)` | "Now: {item}" |
| `GoalRunCopy.earlierMessages` | "Earlier messages" (the count follows as a quiet number) |
| `GoalRunCopy.checklist` | "Checklist" |
| `GoalRunCopy.checklistSummary` | "Checklist · {done} of {count} done", plus " · {n} for you" when n > 0 |
| `GoalRunCopy.noChecklist` | "No checklist yet. Albatross writes one when it starts." |
| `GoalRunCopy.checklistFooter` | "Albatross keeps this list while it works. Tell Albatross in the conversation when something changed." |
| `ChecklistItem.State.word` | done "Done", yours "You", todo and doing none (doing draws the live dot) |
| `RunSource.Kind.word` | web "Web", mail "Mail", file "File", calendar "Calendar", jira "Jira", document "Document", unknown "Source" |
| `GoalRunCopy.sourceLabel` | "{kind word} · {title}"; a web source with no title shows its host |
| `GoalRunCopy.notSure` | "Not sure" |
| `HandoffItem.Kind.word` | draft "Draft", document "Document", sheet "Sheet", deck "Deck", file "File", approval "Approval", event "Event", page "Page", unknown "Item" |
| `HandoffItem.State.word` | ready "Ready", check "Check it", blanks (the blank sentence), unknown "Check it" |
| `HandoffItem.Kind.verb` | draft "Read and send", approval "Approve", page "Open the page", all others "Open" |
| `GoalRunCopy.filesAttached(_:)` | "1 file attached", "2 files attached" |
| `GoalRunCopy.sealedLine(field:)` | "The {field} fills in when you send or download." (the composer row: "… when you send.") |
| `GoalRunCopy.openOnWeb` | "Open on the web" |
| `GoalRunCopy.doneContinue` | "Done, continue" (the second button of a goal handoff, the same words as `DocumentHandoffCopy.done`); `RunBlockCopy.markStepDone` stays "Mark step done" for a step run |
| `GoalRunCopy.packageLine` | "{n} items: {a}, {b}, and {c}." / "… {a}, {b}, {c}, and {n} more." |
| `GoalRunCopy.fromAlbatross` | "From Albatross" |
| `DocumentModeCopy.tab(index:count:)` | "Tab {i} of {n}" (VoiceOver only) |
| `MacDocumentModeCopy.package` | "Package" (the VoiceOver name of the list) |
| `MacThreadCommandState.nextItem`, `.previousItem` | "Next Item", "Previous Item" (menus use title case) |
| `SavedFileCopy.unavailable` | "The file could not be opened. Try again." with "Try again" |
| `SavedFileCopy.openElsewhere` | "This file type opens in the preview." (for a non-PDF saved file) |
| plan line, goal `.ready` | "Ready" |
| plan line, goal `.running` | "Albatross works on it" |

Words that stay: "Handle it", "Stop", "Stop and redirect", "Continue", "Dismiss", "Try again",
"Done, continue", "Back to thread", "Close", "Chat", "What Albatross did", "Read and send",
"Open the document", the state headlines of decision 6.

## 5. Swift model changes

### 5.1 New file `Core/Models/GoalRunModels.swift`

Every type decodes with the `StepRunModels` tolerance: a JSON init at the repository boundary, a
`Codable` init for the offline cache with `decodeIfPresent`, and `.unknown` for a new enum word.

```swift
struct RunSource: Identifiable, Hashable, Codable, Sendable {
    enum Kind: String, Hashable, Codable, Sendable { case web, mail, file, calendar, jira, document, unknown }
    let kind: Kind
    let title: String
    let url: String?
    let referenceID: String?      // wire `id`
    let accountID: String?        // wire `accountId`
    var id: String { "\(kind.rawValue):\(url ?? referenceID ?? title)" }
}

struct RunMessage: Identifiable, Hashable, Codable, Sendable {
    let id: String
    let at: Date?                 // wire `at`, milliseconds, via CalendarDateParser
    let text: String
    let sources: [RunSource]      // the first 8
}

struct ChecklistItem: Identifiable, Hashable, Codable, Sendable {
    enum State: String, Hashable, Codable, Sendable { case todo, doing, done, yours, unknown }
    let id: String
    let text: String
    let state: State
}

struct HandoffItem: Identifiable, Hashable, Codable, Sendable {
    enum Kind: String, Hashable, Codable, Sendable { case draft, document, sheet, deck, file, approval, event, page, unknown }
    enum State: String, Hashable, Codable, Sendable { case ready, blanks, check, unknown }
    let kind: Kind
    let referenceID: String?      // wire `id`
    let url: String?
    let accountID: String?
    let title: String
    let state: State
    let blanks: [String]          // StepRunView.Next.cleanBlanks, the first 6
    let note: String?
    var id: String { "\(kind.rawValue):\(referenceID ?? url ?? title)" }
}

struct DraftAttachment: Identifiable, Hashable, Codable, Sendable {
    enum Provider: String, Hashable, Codable, Sendable { case office, upload, albatross, unknown }
    enum Format: String, Hashable, Codable, Sendable { case pdf, native, unknown }
    let fileID: String            // wire `fileId`
    let provider: Provider
    let format: Format
    let name: String
    let size: Int?
    let contentType: String?
    var sealedLine: String?       // client-side, from the package item note (not on the wire)
    var id: String { fileID }
    var json: JSONValue           // `{ source: "file", fileId, provider, format, name, size?, contentType? }`
}
```

- A `RunSource` with no title, or with neither `url` nor `id`, decodes to nil and drops out.
- A `RunMessage` with empty text drops out. A `HandoffItem` with no title drops out.
- `HandoffItem.id` can collide when two items share a kind and a title and have no id. The
  package view uses `enumerated()` with `"\(offset):\(item.id)"` as the row id.

### 5.2 `StepRunView` (`Core/Models/StepRunModels.swift`)

- New stored properties, all with defaults in the memberwise init: `goal: Bool = false`,
  `messages: [RunMessage] = []`, `checklist: [ChecklistItem] = []`, `items: [HandoffItem] = []`,
  `unsure: [String] = []`.
- JSON init: `goal = json["goal"]?.boolValue ?? false`; the arrays `compactMap` their inits;
  `unsure` keeps non-blank strings, the first 4.
- Codable: a `CodingKeys` list and an `init(from:)` with `decodeIfPresent`, as `Next` does, so a
  cached run from an older build still decodes.
- `with(state:)` copies the five fields.
- `var isGoal: Bool { goal || stepKey == GoalRun.stepKey }` where `enum GoalRun { static let stepKey = "goal" }`.
- `Artifact.Kind` gains `deck` ("Deck") and `file` ("File"). `Target.Kind` gains `file`.
- `var newestChecklist: [ChecklistItem]` is not needed; the view reads `checklist`.

### 5.3 `WorkDetail` (`Core/Models/ProductModels.swift`)

- `goalRuns: Bool?` and `checklist: [ChecklistItem]?` on `WorkDetail`, both optional, read from
  `work_home` (open question 10). `var isGoalWork: Bool { goalRuns ?? false }`.
- `ThreadGoal.isGoalWork(detail:runs:)` reads `detail.isGoalWork || runs.contains { $0.run.isGoal }`,
  so an older `work_home` with goal runs still reads as a goal Work.

### 5.4 Draft attachments

- `ComposePrefill` gains `var fileAttachments: [DraftAttachment] = []`.
- `ProductStore.loadDraftPrefill` reads `row["attachments"]` into `fileAttachments`.
- `ComposeDraftSnapshot` gains `fileAttachments`, so a send that waits and a restored draft keep them.
- `BackendClient.sendMail` (and the draft save path) gains `fileAttachments: [DraftAttachment]`,
  sent as one multipart text part `fileAttachments` with a JSON array (open question 3).

### 5.5 `ThreadRunView` and `StepHandoffItem`

No change. Both wrap `StepRunView`, so the new fields come with it.

## 6. Presentation rules (pure, tested)

### 6.1 `Features/Work/RunBlockPresentation.swift`

- `ThreadState.resolve`: `if steps.isEmpty, !ThreadGoal.isGoalWork(detail: detail, runs: runs) { return .planning }`.
  A goal Work with zero steps never reads `.planning`. The rest of the rule stays.
- `planLine(stepNumber:total:)`: unchanged. A goal Work passes `stepNumber: nil`, so no position.
- `RunBlockCopy.subtitle(_ run:)`: a goal run at work returns "Now: {first doing item}" or nil;
  a goal run that ended returns nil; a step run returns `run.stepTitle`.
- `RunBlockBlanks.draws(_:)`: false when `run.items` is not empty (the rows carry the blanks).
- `RunBlockHandoffAction.primary(for:)`: a goal handoff with no `next` returns
  `.next(.resume, label: "Continue")`, and `.markDone` never applies to a goal run. The second
  button: `RunBlockCopy.secondButtonLabel(_ run:)` returns "Done, continue" for a goal run and
  "Mark step done" for a step run. Both call `actions.markDone`; the model posts the step route
  with `stepKey: "goal"` and `continue: true` through one function (`WorkThreadModel.doneContinue`).
- `ThreadState.planLine(stepNumber:total:goal:)`: `.running` reads "Albatross works on it" for a
  goal Work.

### 6.2 New file `Features/Work/GoalRunPresentation.swift`

```swift
enum GoalRunCopy { /* section 4 */ }

enum GoalRunMessages {
    static func shownCount(_ state: RunBlockState) -> Int   // open 3, else 1
    static func split(_ messages: [RunMessage], state: RunBlockState) -> (earlier: [RunMessage], shown: [RunMessage])
}

enum ChecklistSummary {
    static func line(_ items: [ChecklistItem]) -> String      // "Checklist · 2 of 6 done · 1 for you"
    static func doing(_ items: [ChecklistItem]) -> ChecklistItem?
    static func expandedByDefault(isNewest: Bool, state: RunBlockState) -> Bool  // newest open or stopped
}

enum PackageItemBehaviour: Equatable, Sendable {
    case openDraft(id: String, accountID: String?)
    case openDocument(DocumentTarget)
    case openFile(fileID: String, title: String, contentType: String?)
    case openDeck(id: String)
    case openApproval(id: String?)
    case openEvent(accountID: String, id: String)
    case openURL(String)
    case none
    static func from(_ item: HandoffItem, artifacts: [StepRunView.Artifact]) -> PackageItemBehaviour
    var opensInDocumentMode: Bool                              // document, sheet, deck, file, draft
}

enum PackageRows {
    static func stateLine(_ item: HandoffItem) -> PackageStateLine   // .ready, .blanks([String]), .check(note: String?)
    static func verb(_ item: HandoffItem) -> String
    static func line(_ items: [HandoffItem]) -> String?        // the Brief line, nil when empty
    static func fileID(of item: HandoffItem) -> String?        // `id`, else `?file=` from `url`
}
```

- `PackageItemBehaviour.from`: the client never builds an open path; every item carries `url`
  from the server. `file` reads the file id from `?file=<id>` in `url`, else from `id`. The bytes
  come from `GET /api/files/saved/<fileId>` (the files builder's route). `document`, `sheet`,
  and `deck` use `DocumentTarget.resolve` with the run's artifacts, as the primary button does
  (a deck url carries `?document=<id>`). `draft` needs `id`. `event` needs `accountId` and
  `id`, else `url`. `page` needs `url`.

### 6.3 New file `Features/Work/DocumentModeItems.swift`

```swift
struct DocumentModeItem: Identifiable, Hashable, Sendable {
    enum Content: Hashable, Sendable {
        case document(DocumentTarget)                     // document, sheet
        case deck(id: String)
        case file(fileID: String, contentType: String?)
        case draft(id: String, accountID: String?)
    }
    let id: String
    let kind: HandoffItem.Kind
    let title: String
    let content: Content
    let blanks: [String]
    let note: String?
    let sealed: Bool                                      // a file whose note names a sealed field
    var documentAttachment: DocumentContextAttachment?    // document and deck only
    var workspaceDestination: NativeWorkspaceDestination? // document, sheet, deck
}

struct DocumentModeSet: Hashable, Sendable {
    let runID: String?
    let items: [DocumentModeItem]
    var selectedID: String
    var selected: DocumentModeItem
    var index: Int                                        // for "Tab 2 of 3"
}

enum DocumentModeItems {
    /// The set to open: the items of the handoff that owns `opening`, in package order, with
    /// `opening` selected. With no items (an older run), one item from the target alone.
    static func set(opening: DocumentModeItem.Content, title: String?, runs: [ThreadRunView]) -> DocumentModeSet
    static func item(from item: HandoffItem, artifacts: [StepRunView.Artifact]) -> DocumentModeItem?
    static let tabKinds: Set<HandoffItem.Kind> = [.draft, .document, .sheet, .deck, .file]
}
```

- `DocumentHandoff.run(for:target:)` gains a sibling `DocumentHandoff.run(for:item:)` that also
  matches `items` by id or url, so a handoff owns its file and deck items too.
- `MacDocumentMode.title(runs:target:)` becomes `title(set:)`: the selected item's title.
- `MacDocumentMode.stepLabel` returns nil for a goal run.

### 6.4 `StepRunPresentation.swift`

- `StepRunCopy.readyRowTitle(_:)`: a goal run at work returns "In progress"; a goal run that
  ended returns `headline(run)`. Step runs unchanged.
- `StepRunActions.open(_ behaviour: PackageItemBehaviour, …)` for the Brief and the Details: a
  draft, an approval, an event, and a URL open as today; document-mode kinds return false so the
  caller opens the thread.
- `StepRunActions.open(_ artifact:)` learns `deck` (the document editor) and `file`
  (`.openFile`).

### 6.5 `ThreadRowPresentation.swift`

- `statusLine(_:)`: the `stepTitle` fallback applies only when `stepTitle != row.title`.

## 7. View plan

### 7.1 New files

| File | What it holds |
|---|---|
| `Core/Models/GoalRunModels.swift` | Section 5.1. |
| `Features/Work/GoalRunPresentation.swift` | Section 6.2. |
| `Features/Work/DocumentModeItems.swift` | Section 6.3. |
| `Features/Work/RunMessagesView.swift` | `RunMessagesView(messages:state:onSource:)`: the shown messages, "Earlier messages" disclosure. `RunSourceChips(sources:onOpen:)`: the wrap row (a `Layout` like `BlankFlowLayout`, or `ViewThatFits` per row). `RunSourceChip`. |
| `Features/Work/RunChecklistView.swift` | `RunChecklistView(items:expanded:)`: the disclosure with the summary label and the rows. `ChecklistRows(items:)` for the sheet and Details. `ChecklistSheet` (iOS) with the title "Checklist" and the footer. |
| `Features/Work/PackageView.swift` | `PackageView(items:onOpen:)`: the card. `PackageItemRow`. `UnsureView(lines:)`. `PackageQuietList` for a done run. |
| `Features/Work/DocumentModeItemBar.swift` | The iPhone and iPad capsule row with the selection and the VoiceOver counter. |
| `Features/Work/SavedFileView.swift` | `SavedFileLoader` (`@Observable`): downloads `/api/files/saved/<fileId>` with `backend.download`, keeps the URL, reports an error. `SavedFilePDFView` (PDFKit, one representable with `#if os(macOS)` for `NSViewRepresentable` else `UIViewRepresentable`). `SavedFileView(item:)`: the loader, the PDF or the Quick Look preview, the sealed line, "Open on the web". |
| `Features/Work/DraftItemView.swift` | The read-only draft (To, Subject, body), `DraftAttachmentRows`, "Edit and send". Reads the draft with `loadDraftPrefill`. |
| `Features/Mail/DraftAttachmentRow.swift` | The composer row for a server file: name, "{format} · {size} · From Albatross" or the sealed line, Remove. |
| `Lab86MailMac/Work/MacPackageList.swift` | The leading list of document mode, the capsule fallback, and `MacDocumentModeLayout` (an enum with the widths, not a static on the generic split). |
| `Lab86MailTests/GoalRunModelsTests.swift`, `GoalRunPresentationTests.swift`, `DocumentModeItemsTests.swift`, `DraftAttachmentTests.swift`, `SavedFileLoaderTests.swift` | Section 8. |

### 7.2 Files to change

| File | Change |
|---|---|
| `Core/Models/StepRunModels.swift` | Section 5.2. |
| `Core/Models/ProductModels.swift` | `WorkDetail.goalRuns`, `WorkDetail.checklist`, `isGoalWork`. |
| `Core/Models/WorkThreadStore.swift` | `start(stepKey: String?, stepTitle:, note:, transport:)`: omits `stepKey` when nil or `"goal"`. The optimistic queued run uses `GoalRun.stepKey` and the Work title. |
| `Features/Work/WorkThreadModel.swift` | `handleGoal()` beside `handle(step:)`. `tryAgain` and `sendAgain` pass `nil` for a goal run. `document: DocumentTarget?` becomes `documentSet: DocumentModeSet?` with `openItem(_:)`, `selectItem(id:)`, `closeDocument()`; a computed `document` keeps the Mac View menu rule. `documentYourPart`, `documentBlanks` read the selected item first. `chat.documentAttachment` follows the selection. `finishDocument()` marks the goal run done with `markStepDone` (the run's `stepKey`). |
| `Features/Work/RunBlockPresentation.swift` | Section 6.1. |
| `Features/Work/StepRunPresentation.swift` | Section 6.4. |
| `Features/Work/RunBlockView.swift` | The header subtitle. `openBody`: messages before the log well, then the checklist. `handoffBody`: the newest message, the package, "Not sure", the folded checklist. `stoppedBody`, `doneBody`, `failedBody`: the goal parts. A new `RunBlockActions.openItem: (ThreadRunView, HandoffItem) -> Void` and `openSource: (RunSource) -> Void`. Each body becomes its own small view to keep the type checker fast (section 9). |
| `Features/Work/OutcomeBlockView.swift` | The goal branch: no step rows, no planning row, "Handle it" when `offersHandleIt`. A new `onHandleGoal: () -> Void`. |
| `Features/Work/PlanSheet.swift` | `PlanListView` unchanged. The thread chooses `ChecklistSheet` for a goal Work. |
| `Features/Work/DetailsSheet.swift` | "Checklist" section for a goal Work. "Files" opens `deck` and `file` artifacts through `onArtifact`. |
| `Features/Work/DocumentHandoff.swift` | `DocumentHandoff.run(for:item:)`, `DocumentHandoffCopy` additions. |
| `Features/Work/DocumentModeView.swift` | Takes `DocumentModeSet`. The capsule bar, the item switch (`switch item.content`), the bar with the selected item's blanks and the sealed line. |
| `Features/Work/WorkThreadView.swift` | `actions.openItem`, `actions.openSource`, `handleGoal`, the plan line opens `ChecklistSheet` for a goal Work, `performNext` opens document-mode kinds through `openItem`, `applyIntent` unchanged. |
| `Features/Work/ThreadRowPresentation.swift` | Section 6.5. |
| `Features/Today/ReadyForYouSection.swift`, `Lab86MailMac/Today/MacReadyForYouRow.swift` | The goal caption and the package line. |
| `Features/Mail/ComposeView.swift` | `@State fileAttachments: [DraftAttachment]`, the rows under the subject, the send and the save carry them. |
| `Features/Shell/NavigationModel.swift` | `ComposePrefill.fileAttachments`. |
| `Core/Models/ProductStore.swift` | `loadDraftPrefill` reads `attachments`. |
| `Core/API/BackendClient.swift` | `sendMail(... fileAttachments:)`, the multipart part. |
| `Lab86MailMac/Work/MacDocumentMode.swift` | `MacDocumentSplit` takes the set and a selection binding, mounts `MacPackageList` on the leading side, the dock title from the selection. `MacDocumentMode.title(set:)`, `stepLabel` nil for goal runs. |
| `Lab86MailMac/Work/MacWorkThreadView.swift` | `stage` passes the set; `openItem`; the View menu requests for next and previous item; `planPopover` shows `ChecklistRows` for a goal Work. |
| `Lab86MailMac/Work/MacThreadLayout.swift` | `documentRoom` with the list width; `MacDocumentModeLayout.listWidth`. |
| `Lab86MailMac/Shell/MacThreadCommands.swift` | "Next Item" and "Previous Item" as `Button`s in a new `CommandGroup`, not a Picker (section 9). `MacRequests.nextItemToken`, `previousItemToken`. |
| `Lab86MailTests/Tour/NativeTourFixtures.json` | `workHome["w-invoice-goal"]` with zero steps, `goalRuns: true`, and the scenarios of section 8.3. |

### 7.3 Actions

- `actions.openItem(view, item)`: `PackageItemBehaviour.from(item, artifacts:)`. Document-mode
  kinds call `model.openItem(DocumentModeItems.set(opening:…))`. A draft calls the composer path
  with the attachments. Approval, event, page, URL go through `StepRunActions`.
- `actions.openSource(source)`: web and jira open the URL; mail opens
  `navigation.openThread(accountID:threadID:)` when `accountId` and `id` are present, else the
  URL; calendar opens `navigation.openEvent`; file and document open through `openItem` rules
  with a `HandoffItem` built from the source. A source that cannot open on this device opens its
  URL, else nothing (the chip is still readable).
- "Open on the web" under a sealed file: `model.webURL` plus `view=files&file=<id>` (open
  question 9).

## 8. Test plan

Unit tests use Swift Testing (`@Test`, `#expect`), as the neighbours do. Rendering tests and the
tour use XCTest. No test needs a network or a Mac; the Native acceptance CI runs them.

### 8.1 Unit tests

| File | Cases |
|---|---|
| `GoalRunModelsTests.swift` | Decodes the full goal run (goal, 2 messages with sources, 6 checklist items, 3 items, 2 unsure). Decodes the minimal run with the five keys absent (defaults). An unknown source kind, checklist state, item kind, and item state read as `.unknown`, not as a failure. A source with no title or no url and id drops out. A message with empty text drops out. The Codable round trip of a run with and without the new keys (cache). `with(state:)` keeps the five fields. `isGoal` for `goal: true` and for `stepKey: "goal"`. `Artifact.Kind` deck and file labels. `DraftAttachment` JSON round trip and `.unknown` provider. |
| `GoalRunPresentationTests.swift` | `ThreadState.resolve` reads `.ready` for a goal Work with zero steps and no runs, and `.running`, `.readyForYou`, `.needsAnswer` from its runs. A step Work with zero steps still reads `.planning`. The plan line of a goal Work has no position. `subtitle` reads "Now: …" only on an open goal run. `GoalRunMessages.split` shows 3 on an open run, 1 on a handoff. `ChecklistSummary.line` for 0, 2 of 6, and with a `yours` item. `PackageRows.stateLine`, `verb`, and `line` for each kind and state. `PackageItemBehaviour.from` for each kind, the `?file=` url, the id-only Word file. `markDoneLabel` by run kind. `RunBlockBlanks.draws` is false with items. `readyRowTitle` for a goal run. `statusLine` does not repeat the title. Every copy string has no "-ing" word (the neighbours' check). |
| `DocumentModeItemsTests.swift` | The set from a handoff with 3 items opens the chosen one. The set from an old run has one item. Approval and page items are not tabs. The chat attachment follows a document and is nil on a file. `DocumentHandoff.run(for:item:)` finds the handoff by item id and by url. `MacDocumentMode.title(set:)` and `stepLabel` nil for a goal run. |
| `DraftAttachmentTests.swift` | `loadDraftPrefill` maps `attachments`. The send body carries the `fileAttachments` part. Remove drops one row and keeps the local files. The row text: size, "From Albatross", the sealed line. |
| `SavedFileLoaderTests.swift` | The loader asks `/api/files/saved/<id>`, keeps the URL, and reports a 404 as the unavailable line. A PDF content type picks `PDFView`; another type picks the preview. |
| `MacDocumentModeTests.swift` (additions) | The list shows with 2 items and hides with 1. `documentRoom` with the list width. "Next Item" wraps. The View menu items dim with one item. |
| `RunBlockPresentationTests.swift` (additions) | "Handle it" shows for a goal Work with no step. The outcome block has no planning row for a goal Work. |
| `StepRunTests.swift` (additions) | The Brief row line for a goal run with a package. `StepRunActions.open` for a deck and a file artifact. |
| `WorkThreadStoreTests` (new cases in the store tests that exist, or in `GoalRunModelsTests`) | `start(stepKey: nil)` sends no `stepKey`; `start(stepKey: "goal")` sends none either. |

### 8.2 Rendering tests (XCTest, PNG to the evidence directory)

- `RunBlockRenderingTests`: an open goal run with 2 messages and chips; a package with the
  three rows and one blank sentence; "Not sure" with two lines; a stopped goal run with the
  checklist open. Light and dark. One large Dynamic Type size for the chips (they wrap).
- `DocumentModeItemBarRenderingTests`: three capsules, the second selected.
- `DraftAttachmentRowRenderingTests`: a row with a size and a row with the sealed line.
- Mac: `MacPackageListRenderingTests` with the offscreen `NSHostingView` recipe.

### 8.3 Tour screenshots

Fixtures: `workHome["w-invoice-goal"]` (title "Bill Harbor Design for the quarter", zero
`guideSteps`, `goalRuns: true`, a contract, no questions). Scenarios with `paths`
`/api/albatross/work/w-invoice-goal/runs` and `/api/chats`, times as `@ms:now-9m`.

| Test | Screen id | What it shows |
|---|---|---|
| `testTour30WorkThreadGoalRun` | `work-thread-goal-run` | The open goal run: "Now: …", two messages with chips, the checklist open, the folded log, Stop. Full page. |
| `testTour31WorkThreadGoalPackage` | `work-thread-goal-package` | The handoff: summary, newest message, the package with a blank sentence row and a sealed row, "Not sure", "Read and send" and "Mark done". Full page. |
| `testTour32WorkThreadGoalStopped` | `work-thread-goal-stopped` | Stopped at the time limit with the checklist 4 of 6 and "Continue". |
| `testTour33DocumentModePackage` | `document-mode-package` | iPad: the capsule bar, the Word editor placeholder, the thread column with the invoice blanks. iPhone: the bar and the bottom bar. The stub serves the workspace page as the document tour of today does. |
| `testTour34DocumentModeFile` | `document-mode-file` | The W-9 tab: a fixture PDF from the test bundle through the stub route, the sealed line, "Open on the web". |
| `testTour35ComposeAttachments` | `compose-attachments` | The composer with two file rows. |
| `testMacTour24WorkThreadGoalRun` | `mac-work-thread-goal-run` | As iOS, at the reading measure. |
| `testMacTour25WorkThreadGoalPackage` | `mac-work-thread-goal-package` | As iOS. |
| `testMacTour26DocumentModePackage` | `mac-document-mode-package` | The package list, the center, the thread column. |
| `testMacTour27ComposeAttachments` | `mac-compose-attachments` | The compose sheet with the rows. |

The old thread screens (22 to 29, Mac 14 to 23) stay and must not change. That is the test for
G10.

## 9. Risky compile spots

- Long modifier chains: `RunBlockView.handoffBody` already carries a dozen children. Each goal
  part is its own `View` struct (`RunMessagesView`, `RunChecklistView`, `PackageView`,
  `UnsureView`), and each body (`openBody`, `handoffBody`, `stoppedBody`) stays under about 12
  children. The thread views keep their layered `body` pattern.
- Generic views cannot hold static stored properties: `MacDocumentSplit<Column>` gets no
  `static let`. The widths live in `enum MacDocumentModeLayout` and in `MacThreadLayout`.
- `Picker(.inline)` in a `CommandGroup`: the View menu already has one inline Picker (the filter).
  "Next Item" and "Previous Item" are plain `Button`s in their own `CommandGroup(after: .sidebar)`
  block. No second Picker in that group.
- `PDFView` is an `NSView` on the Mac and a `UIView` on iOS: one file with
  `#if os(macOS) … NSViewRepresentable … #else … UIViewRepresentable … #endif`, the same
  configuration function for both. `import PDFKit` under both branches.
- `fullScreenCover` is iOS only (as today, `#if os(iOS)`).
- `ForEach` over `items` needs stable ids: use `Array(items.enumerated())` with
  `id: \.offset` and the item id in the accessibility identifier.
- `DisclosureGroup` inside a `LazyVStack` animates its height; keep `withAnimation(.easeInOut(duration: 0.18))`
  as the log does, and no `.animation` on the stack.
- The chip wrap: a custom `Layout` is simplest and already proven (`BlankFlowLayout`). Do not
  reach for `ViewThatFits` with 8 alternatives; the type checker slows down.
- `@Observable` `SavedFileLoader` with a `Task` in `.task(id: fileID)`; cancel on disappear and
  delete the temporary file.
- `WorkThreadModel.document` stays as a computed property so `MacWorkThreadView.onChange(of: model.document)`
  still compiles; the new `documentSet` is the stored one.
- `Codable` on `StepRunView` with the new keys: the `CodingKeys` enum must list every stored
  property, or the synthesized encoder drops fields silently.

## 10. Decisions in this note

1. Messages read as Albatross's own voice: body text, no bubble, no time, newest three on an
   open run and newest one on an ended run. Older messages fold with a quiet count.
2. Sources are text capsules under the message: "{kind} · {title}". No icons. At most 8.
3. The checklist uses the plan-row grammar: a state word column, the live dot for `doing`,
   "You" for `yours`. It is open on the newest run and folded on older blocks.
4. The package is one card with one row per item; the row carries the state and one verb. Blanks
   draw as the blank sentence on the row. A sealed field shows as the item note.
5. "Handle it" on a goal Work sits in the outcome block with no step. It posts `start` with no
   `stepKey`.
6. The header of a goal run never repeats the Work title. It shows "Now: {doing item}" at work.
7. Document mode holds a set of items. iPhone and iPad switch with a capsule bar; the Mac adds a
   leading list, with capsules in the dock header when the window is narrow.
8. A saved PDF opens in a native `PDFView`, read-only. Other saved types open in Quick Look. The
   identity check for a sealed download goes to the web ("Open on the web").
9. A run's draft opens in the full composer with the server files as removable rows. The inline
   chat draft does not change this round.
10. "Done, continue" on a goal handoff (never a one-tap close of the Work); "Mark step done" stays
    on step runs.
11. Old step Works do not change: every new part is gated on a non-empty array or `isGoal`.

## 12. Lead review (2026-10-15)

Approved with these changes, now in the sections above:

- No "Mark done" on a goal handoff. The second button reads "Done, continue". With no items and
  no `next`, the button is "Continue".
- The goal plan line at work reads "Albatross works on it".

Answers to the open questions: (1) omit `stepKey` on "Handle it" for a goal Work; (2) "Done,
continue" posts the step route with `stepKey: "goal"` and `continue: true`, through one function;
(3) the attachment API comes from the files builder: the model, the rows, and the views are built
now, the network calls sit behind one small client function each (`DraftAttachmentClient`);
(4) saved-file bytes come from `GET /api/files/saved/<fileId>`, and a sealed file sends the user
to the web; (5) the client never builds open paths, every item carries `url`; (6) no file
attachment kind for chat context; (7) the thread-list preview is server side; (8) PDFs are
read-only on device.

## 11. Open questions for the lead

1. The start route: does `POST /run { action: "start" }` with no `stepKey` start a goal run for a
   user in the switch? Or must the client send `stepKey: "goal"`? This note omits the key.
2. "Mark done" on a goal handoff: does `POST /step { stepKey: "goal", continue: true }` check the
   contract and close the Work, or does it only close the handoff? The label depends on it.
3. The compose route: this note sends the server references as one multipart text part
   `fileAttachments` (a JSON array of `DraftAttachment`). The web builder must read it, and the
   draft save route must accept and return `attachments`. `list_drafts` rows must carry them.
4. The bytes of a saved file: this note reads `GET /api/agent/uploads/<fileId>` with the Clerk
   session. Confirm that saved files (`agentUploads`) are served by that route, or name the route.
5. A deck item: confirm that its `id` is an Albatross document id that `?document=<id>` opens.
6. The chat context on a file or draft tab: the contract has only `{ kind: "document" }`. This
   note sends nothing on those tabs. Say if a `{ kind: "file", id }` attachment should exist.
7. The thread list `preview` for a goal run at work: the newest run message, so the row does
   not fall back to the Work title.
8. Native PDF form fields: read-only in this round. Say if the user must fill a PDF field on the
   phone (PDFKit can, with a save route for the bytes).
9. "Open on the web" for a sealed download: `?view=files&file=<id>` is the web path. Confirm
   the download control and the identity check live on that page.
10. `work_home`: `goalRuns` and `checklist` on the detail (the brief names them). Until they
    exist, the client reads goal Works from the runs alone.
11. Taste: at a handoff this note shows the summary, then the newest message. If the two repeat
    each other too often in practice, the newest message folds too.
