# Albatross goal runs, web design note (2026-10-15)

Status: design only. No production code changed. The brief is `docs/albatross-goal-runs.md`
(owner decisions D1 to D3, sections G1 to G6, the contract summary) and the shared shapes in
`lib/albatross/goal-run-contract.ts`. The thread itself is PR 1 (`docs/albatross-thread.md`),
the rail is PR 3 (`docs/albatross-threads.md`), document mode is
`docs/albatross-document-handoff.md`, and the blank is `docs/albatross-blank-design.md`. This
note decides how the web thread shows a goal run, its sources, its checklist, its package, the
document tabs, the PDF viewer, and the draft attachments. iOS and macOS get their own notes.

Mockup: `/tmp/goal-runs-web-mockup/index.html`, rendered at 1440 x 900 (2x) and 390 x 844 (2x):

| PNG | What it shows |
|---|---|
| `/tmp/goal-runs-web-mockup/running.png` | A goal run in progress: messages with source chips, the open checklist, the live line, the folded log, Stop, and the composer routed to the run. |
| `/tmp/goal-runs-web-mockup/running-dark.png` | The same in dark mode. |
| `/tmp/goal-runs-web-mockup/package.png` | The run handed off with a package of four items, the blank sentence, "Not sure", and the three buttons. |
| `/tmp/goal-runs-web-mockup/details.png` | The Details panel with Checklist, Package, Sources, and Files. |
| `/tmp/goal-runs-web-mockup/document.png` | Document mode with four tabs; the invoice (Word, from the template) is active, with its blank content controls. |
| `/tmp/goal-runs-web-mockup/pdf.png` | Document mode with the filled W-9 (PDF) active; the sealed tax ID field is marked. |
| `/tmp/goal-runs-web-mockup/draft.png` | Document mode with the draft active: the composer with three attachment rows. |
| `/tmp/goal-runs-web-mockup/stopped.png` | A run stopped at its time limit, with the checklist at 4 of 7 and Continue. |
| `/tmp/goal-runs-web-mockup/failed.png` | A run that did not finish, with Try again. |
| `/tmp/goal-runs-web-mockup/done.png` | The closed package run, the continued run, the proof line, and "Done." |
| `/tmp/goal-runs-web-mockup/mobile.png` | The package at 390 px. |
| `/tmp/goal-runs-web-mockup/mobile-pdf.png` | Document mode at 390 px: the tab strip, the PDF, the bottom bar. |

All sample data is invented: Sam Rivera, Bramble Press, Priya Natarajan at
`bramble-press.example.com`, Jira key BP-214, 555 numbers. The only real site is irs.gov, which
is where a W-9 comes from.

## 0. The design in twelve lines

1. A goal run is one block in the thread, as a step run is today. Its header is the start time and
   the state word. No "Step N".
2. The block reads top to bottom: earlier messages (folded), the newest messages, the checklist,
   the live line, the log (folded), the buttons.
3. Each message is prose. Its sources are text chips under it: the title, then the kind in the
   faint voice. A chip opens the source. No numbered citations: the contract has no anchors.
4. The checklist is a list of circles and text. Done is a soft check, doing is the accent dot with
   one halo, todo is a hollow circle, yours is a hollow circle in the blank voice with "Yours".
5. The live line is the "doing" item, else the newest log line. One shimmer, as today.
6. The end of a run is: the newest messages, the blank sentence, the package rows, "Not sure",
   then the buttons. The summary shows only when the run has no messages.
7. A package row is the title, the kind word, and one state line: "Ready.", "Fill in rate.", or
   "Check it.", with the item note after it. The row opens the item.
8. The main button opens document mode with one tab for each item that has a pane. The
   `next.target` tab is active. "Mark it done" and "Dismiss" sit beside it.
9. Document mode gets a 38 px tab bar above the editor. A tab is the item title and, while the
   item still needs the user, a dot at the end, in the blank voice. "Close" is at the right end.
10. A PDF opens in a new `PdfPane` (pdfjs-dist). A sealed field is marked on the page: "Fills in
    when you send". Download runs the identity check first.
11. A draft opens as the composer in the center. Attachments are rows: name, kind and size, a
    note for a sealed file, and "Remove".
12. Old step Works change nothing: the step header, the plan strip, and the step buttons stay.

## 1. Research findings and the decision each one drives

### 1.1 Mobbin (web, images inspected)

| Screen | Taken | Rejected |
|---|---|---|
| ChatGPT, deep research activity panel ([screen](https://mobbin.com/screens/73833b79-1dd5-4354-8fc4-a2e99c33a75e)) | The activity is a list of short sentences ("Read more from irci.jp", "Searched for ..."). Sources are small domain pills in the prose, and one "Sources" count at the end of the message. | The right panel for the activity. Our activity is the run block in the thread; the Details panel holds the sources list. |
| Google Gemini, deep research ([screen](https://mobbin.com/screens/bcc65f48-0e66-49d4-b648-0566d26b6c56)) | One narrative paragraph for each phase, then a grid of site chips "Researching websites". The chip is host plus title. | Favicon-first chips (icons before text). The italic narrative voice. |
| Mistral Le Chat, research in progress ([screen](https://mobbin.com/screens/181ce284-3dcd-4d44-bb1f-368d2e5db997)) | "30 Sources" as one quiet count while it works; "Cancel" at the end. | The avatar cluster and the heat-map strip. |
| Gemini Notebook ([screen](https://mobbin.com/screens/bc512cf4-f297-4865-802f-88f2fcc2e8a1)) | A sources column with every source listed once, and "8 sources" in the composer. The Details panel's Sources section follows this. | Numbered inline citations: our contract attaches sources to a message, not to a sentence. The checkbox column. |
| Customer.io, agent reply ([screen](https://mobbin.com/screens/fafcbfb9-fa85-4b4d-b17f-54df962305b5)) | "Searched docs" as a folded disclosure in the prose. A "5 references" popover with title and URL. | The popover: a chip opens the source at once; the title attribute carries the URL. |
| Cohere playground ([screen](https://mobbin.com/screens/a51418f9-3eb4-470b-98cf-eebb757aa0c7)) | "Citations:" is a row of domain chips with "+8" for the rest. The chip row and the "+N" overflow come from here. | The favicon before each domain. |
| Sana AI ([screen](https://mobbin.com/screens/67047d63-2ae6-44e0-a2a2-8d6989a14819)) | "Done" as a folded disclosure above the answer. | Numbered sources inside the prose. |
| Lindy, agent at work ([screen](https://mobbin.com/screens/9f4affd5-f387-4149-860e-95c83f9bbba5)) | The checked task list inside the message: a check for each done item, one line "Processing..." for the current one. Our checklist and live line are this, with our states. | The chevron on every row (each row was a disclosure). "Start computer" and "Use Computer" cards. |
| Lightfield ([screen](https://mobbin.com/screens/5b5f4b9f-5940-47a0-845d-f6c74bac4de8)) | One receipt chip for each thing made, in order. | Fifteen "Task created" chips before the list: the package is one list, not a chip for each file. |
| Obvious ([screen](https://mobbin.com/screens/3f156c7b-dfda-4c2e-9c36-9492fe789c2b)) | Tool groups fold between narrative lines ("Ran through 5 things"). The right pane has a checklist grouped with counts "0/2". | Folded groups between every message: one log at the bottom keeps the block calm. Checkboxes the user can tick: the user cannot tick our checklist (G1). |
| Unify ([screen](https://mobbin.com/screens/ca1f0060-e1ab-4ba2-98f9-6a9789f2afc4)) | "Waiting for your answer 8s" as a state word with a time; one-sentence "why" under a decision. The messages say why in one sentence (G2). | The "1/4" question stepper. Our forms are one card. |
| Perplexity Computer ([screen](https://mobbin.com/screens/480150e8-5939-40ee-880d-07cd239bb113)) | Narrative, then folded tool lines ("Sharing cat_meow.mp3"), then a result card with the file and Download. The right column lists "Artifacts 1", "Sources", "Usage 1m 22s". | A separate right column for artifacts and sources: ours go in Details. |
| Manus, batch download ([screen](https://mobbin.com/screens/4ed516ff-ca56-4704-93bd-c39f50dc4950)) | One list of every file made, with the time, and one download for all. The package rows list every item once. | The checkboxes and the modal. |
| Claude Design, chat beside files ([screen](https://mobbin.com/screens/72e05bff-4ccf-4118-a532-079bbe8eb65f)) | Folded tool groups in the chat ("Writing x4, Done, Listing files"); a tab bar over the files ("Design Files"); file meta "HTML page · Modified 7m ago · 16.0 KB". The PDF pane header follows this meta line. | The file tree in the center. Our items are at most eight; tabs are enough. |
| Dropbox Dash, canvas ([screen](https://mobbin.com/screens/09e3f23a-6afc-46b2-8079-2e20a8b8c879)) | The source PDF card and the made document card sit in the chat; the document opens at the right. | The chat on the left: our thread stays on the right (D5 of the document handoff). |
| Mistral Le Chat, canvas ([screen](https://mobbin.com/screens/76e16697-0e20-4bfc-8162-e93d6f1fc8ff)) | An artifact card "Black Holes Explained Simply · Text · Modified" in the chat opens the right canvas. The package row is this card, with the kind word at the right. | One canvas for one artifact: we need tabs for a package. |
| Dovetail, PDF beside the summary ([screen](https://mobbin.com/screens/b0539367-3968-4598-b566-a8899a50440b)) | The PDF viewer header: the file name and "Page 1 ▾". | Numbered citation pills in the summary (no anchors in our contract). |
| Fabric, document and chat ([screen](https://mobbin.com/screens/61d7d915-b6d3-4f7b-8544-ed2701fdce96)) | "Current file" as a context chip in the composer. Our composer placeholder already names the document. | Tabs for Comments, Info, Ask on the chat side. |
| Otter, tabs over a document ([screen](https://mobbin.com/screens/5cd02bb5-3338-4f8e-87aa-6fc8e87272d6)) | "Summary | Transcript" as an underline tab bar above the document, chat at the right. The tab bar style. | Nothing else. |
| Xero, send invoice ([screen](https://mobbin.com/screens/c9763dbd-e365-4b73-870c-d089e748229f)) | "Files included with online invoice" lists the PDF as a removable item with its size. The preview tabs "Invoice email | Invoice PDF" beside the composer are our draft and document tabs. | The "Attach PDF to email" checkbox: the attachment row is the control. |
| Front, attachments on a message ([screen](https://mobbin.com/screens/19572002-c8db-4063-b7f6-1a1b859c4614)) | "1 Attachment" with the file name and size in one row. | "Download all". |
| Notion Mail, compose ([screen](https://mobbin.com/screens/47cbd448-be7d-41c0-903e-f501384b3db5)) and Skiff ([screen](https://mobbin.com/screens/8d044455-db11-493c-918d-483b2af410a9)) | The attachment sits between the body and Send, with its size and a remove control. | Chips: a chip hides the kind and the sealed note. We use rows. |
| Microsoft Copilot, references ([screen](https://mobbin.com/screens/e631b279-cfc4-4c1c-85c9-f06c838b8df2)) | "References 31" as a numbered list of host chip plus title. The Details Sources list follows this. | The "See my thinking" panel of "Searching ..." lines: our log is this, folded. |

### 1.2 Registry parts

| Part | Decision |
|---|---|
| `@ai-elements/sources` (`Sources`, `SourcesTrigger`, `SourcesContent`, `Source`) | Install and restyle. The trigger becomes the "+N" overflow chip; the content is the full chip row. The book icon before the trigger text goes (no icons before text). |
| `@ai-elements/chain-of-thought` | Not used. Each step starts with an icon, and the steps are a sequence. Our checklist is a list of states. |
| `@ai-elements/task` (vendored at `components/ai-elements/task.tsx`, restyled) | The folds: "Earlier messages", "Checklist", "What Albatross did". The same primitive the run block uses today. |
| `@tool-ui/citation` (vendored at `components/tool-ui/citation`) | Not used for chips. It is icon-first and opens a hover popover. Its `extractDomain` is the only part to copy. |
| `@tool-ui/progress-tracker` (vendored) | Not used. It is a stepper with icons. |
| `BlankSentence` (`components/albatross/BlankSentence.tsx`) | The headline of a package handoff and of the "Your part" card, as today. |
| `pdfjs-dist` 6.3 (dependency, used on the server in `lib/content/extract.ts`) | The PDF pane renders pages to canvas with it on the client (`pdfjs-dist/webpack` or the legacy build with a worker URL; the builder checks the Next config). |

### 1.3 What the code gives us today (survey of the worktree)

- `ThreadRunView` already carries `goal`, `messages`, `checklist`, `items`, and `unsure` (empty on
  old rows). `cleanHandoffItems` sets `state: 'blanks'` when an item has blanks.
- `RunBlock.tsx` renders the header, the shimmer line, the `Task` log, the stopped and failed
  lines, the summary, the artifact rows, the question form, the allow block, the blank sentence,
  the page row, and the buttons. The goal block keeps every one of these and adds the messages,
  the checklist, the package rows, and "Not sure".
- `runBlockAction`, `runBlockMarksDone`, and `runBlockDismisses` in `thread-view.ts` decide the
  buttons. They need one goal rule (section 3.6).
- `planLine` writes "Step 1 of 2 · Your turn". A goal Work has `totalSteps === 0`, which today
  reads "Your move". It needs the state word alone (section 4.1).
- `PlanIntro` shows the outcome and the plan strip. A goal Work has no strip; it shows "Handle
  it" when nothing is open (section 4.1).
- `DocumentPane.tsx` has `ThreadDocumentEditor` (one target), `YourPartCard`, `YourPartBar`, and
  `DocumentSplit`. The tabs wrap the editor; the card becomes per item (section 5).
- `documentHandoffFor` matches a target to a run by `next.target` or the artifacts. It must also
  match the package items (section 11).
- `InlineComposer.tsx` holds browser `File` objects for new attachments (`FileChip`, 260 px
  chips). Saved `DraftAttachment` rows are new (section 6).
- `openSavedDraft` in `step-run-navigation.ts` opens a draft in the compose overlay through the
  `compose` store state. The draft tab reuses the same prefill.
- `savedFileOpenPath` is `/?view=files&file=<id>`; `FilesSurface` reads `?file=`. The PDF pane
  reads the same bytes route the Files page uses for a saved upload.
- `threads.ts` builds the rail preview from `run.nextDetail`, `run.summary`, and `run.logLine`.
  A package needs its own line (section 4.4).
- `readyForYouRows` and `documentsWaitingRows` read `next` only; they need the items (section 4.5).
- `thread-memory.ts` keeps the draft and the scroll place for each thread. The active tab joins it.
- `ShimmerText` already respects `useReducedMotion`.

## 2. User stories

Platform: web. Each story names the screen state in the mockup.

- **U1. Watch a run work** (`running.png`). I press "Handle it" or write "Go ahead and invoice
  Priya for July". One block shows "Started 2:31 PM" and "In progress". Albatross writes short
  messages into the block as it works. The newest message is at the bottom. Under the messages,
  the checklist shows what is done, what it works on now, and what is left. The live line repeats
  the "doing" item. I can stop it.
- **U2. Read a fact and open its source** (`running.png`). A message says "The BP-214 worklog
  shows 78 hours in July". Under it, two chips: "BP-214 worklog, July · Jira" and "July hours ·
  Mail". I press the first chip. The Jira issue opens in a new tab. I press the second. The mail
  thread opens in Mail.
- **U3. See what is left on the checklist** (`running.png`, `details.png`). The checklist in the
  block says "2 of 7". Five items are open. One says "Yours": only I can do it. The Details panel
  shows the same list at the top, so I can watch it while the block scrolls away.
- **U4. Open each item of a package** (`package.png`, `document.png`). The run ends with four
  rows: the draft, the invoice, the hours sheet, the W-9. Each row says what it needs from me. I
  press "Open the package". Document mode opens with four tabs. The invoice tab is active because
  the main button points at it. I move between the tabs.
- **U5. Fill blanks in the invoice** (`document.png`). The invoice tab shows the Word file from
  the template. The rate is a content control, marked in the page. The "Your part" card says
  "Fill in rate." I type the rate in the document, or I tell Albatross "Use $90 an hour". The
  control fills, the amount and the total follow, and the card says "All blanks are filled in."
- **U6. Check a filled W-9 with a sealed tax ID** (`pdf.png`). The W-9 tab shows the PDF. My
  name, address, and the Individual box are filled. The tax ID boxes are empty, marked "Fills in
  when you send". The card says the ID fills in when I send the mail, or when I download the file
  after One more check. I press "Download": the identity check runs, then the filled file
  downloads once.
- **U7. Send the draft with attachments** (`draft.png`). The draft tab shows the composer in the
  center: To, Subject, the body, then three attachment rows with the kind and the size. The W-9
  row says "The tax ID fills in when you send." I remove a file or add one. I press "Send". The
  tab shows "Sent", the package row says "Sent 3:02 PM.", and the run that continues reads the
  sent mail as proof.
- **U8. Steer a run with a note** (`running.png`). While it works, the composer says "To the run
  · Make the invoice from the template". I write "Use the hours from the timesheet, not Jira".
  The note shows "Sent to the run", then "Read by Albatross · 2:40 PM". The next message says what
  it changed. "Stop and redirect" works as in PR 3.
- **U9. A run that stops at its limit** (`stopped.png`). After 30 minutes the block says "Stopped"
  and "Albatross stopped at its time limit. The next run starts from the checklist." The
  checklist shows 4 of 7 done. "Continue" starts the next run. The block shows no "Handle it".
- **U10. A run that did not finish** (`failed.png`). The block says "Did not finish" and the
  error in one line. "Try again" starts a new goal run.
- **U11. Done** (`done.png`). After I send the mail, the continued run reads it, writes one
  message, and shows the proof line "Confirmed · Mail sent to priya@bramble-press.example.com,
  Oct 15". The earlier package block says "Closed", its rows say "Sent" and "Ready", and the
  thread ends with "Done."
- **U12. An old step Work.** A Work with a plan from before this change opens as today: the plan
  strip, "Step 1 of 2", step run blocks with "Step 1", "Mark step done". Nothing in this note
  changes it. A Work that moves to goal runs with done steps shows "2 steps done before this" as a
  fold under the summary.
- **U13. Needs an answer.** A goal run asks one form. The block shows the messages so far, the
  checklist folded, then the form card as today. The jump pill says "Albatross needs an answer".
- **U14. The Brief and the Documents page.** The Brief's "Ready for you" row says "4 items:
  Invoice 0007 to Priya, Invoice 0007, Hours, July, Form W-9, filled" with "Open the package".
  The Documents page lists the invoice under "Waiting for you" with "Fill in rate." and the W-9
  with "Check it."

## 3. The goal run block

`RunBlock` renders a goal run when `run.goal` is true, or when `run.messages.length`,
`run.checklist.length`, or `run.items.length` is above zero (an old row never has these).

### 3.1 Anatomy, top to bottom

```
┌ run block ────────────────────────────────────────────────────────────────┐
│ Started 2:31 PM                                             In progress     │  header
│ Earlier messages  4  ›                                                      │  fold (messages older than the newest 6)
│ I look for the hours you worked for Bramble Press in July: ...              │  message
│ The BP-214 worklog shows 78 hours in July, across 11 days. ...              │  message
│ [BP-214 worklog, July · Jira] [July hours · Mail]                           │  source chips
│ Checklist  2 of 7  ⌄                                                        │  fold (open while the run works)
│   ✓ Find the July hours                                                     │
│   ● Make the invoice from the template                                      │
│   ○ Get the W-9 from irs.gov and fill it in                                 │
│   ○ Fill in the rate and send the mail                               Yours  │
│ Make the invoice from the template                                          │  live line (shimmer)
│ What Albatross did  14  ›                                                   │  fold (closed)
│ [Stop]                                                                      │  buttons
└─────────────────────────────────────────────────────────────────────────────┘
```

The block keeps the PR 1 frame: a hairline, 16 px side padding, 10 px gaps, `data-slot="run-block"`.

### 3.2 Header

- Left, 12 px muted, tabular: "Started 2:31 PM" while the run is queued or in progress. After the
  run ends: the start time and the duration, "2:31 PM · 13 min". Under one minute: "under a
  minute". Over an hour: "1 h 12 min".
- Right, 11.5 px, the state word in its voice, as today. A finished run adds the end time in the
  faint voice: "Ready for you · 2:44 PM". A handoff that a later run or "Mark it done" closed reads
  "Closed · 2:44 PM".
- No "Step N" and no step title. The Work title is the page title. The header stays
  `aria-label="{title}: {state}"` and `aria-live="polite"` on the state word.

### 3.3 Messages and sources

- A message is one paragraph, 13.5 px, line height 1.55, the text colour. Markdown is not
  rendered; the model writes plain text (G2). Line breaks in the text stay.
- No time stamp on a message. The `title` attribute of the paragraph carries the time, and the
  log carries the same minute. The header has the start time.
- While the run works, the newest 6 messages are open. The older ones fold under "Earlier
  messages" with the count. A finished run shows the newest 3 open. The fold is the vendored
  `Task` (closed by default). The fold opens in place; the thread keeps its scroll place at the
  bottom when it was there.
- The contract keeps the newest 40 messages on a row. The client does not show "and N more": the
  row never holds more.
- Sources render as chips under the message, in one row that wraps, 5 px apart, 22 px tall,
  11.5 px, a hairline, the elevated surface, radius 7 px. A chip is a button.
- Chip text: the title, then " · " and the kind word in the faint voice. The title is cut at 32
  characters with an ellipsis; the `title` attribute carries the full title and the URL.
- Up to 4 chips show. With more, the fifth chip is "+N" (`SourcesTrigger` restyled) and opens the
  rest in place. A message has at most 8 sources (contract).
- The kind word and what a press opens:

| `source.kind` | Kind word | A press opens |
|---|---|---|
| `web` | the host (`irs.gov`), from `extractDomain(url)` | A new tab, `noopener,noreferrer`, through `webUrl()` (only http and https). |
| `mail` | Mail | The mail thread in Mail: `setPrimaryView('mail')`, select the account by `accountId`, `setSelectedThread(id)`. |
| `jira` | Jira | A new tab to `url`. With no URL: nothing, and the chip is text (`<span>`). |
| `file` | File | If a package item has the same id: that tab in document mode. Else Files, `/?view=files&file=<id>`. |
| `document` | Document | If a package item has the same id: that tab. Else `documentTargetOf(url, id)` in document mode, as an artifact row does today. |
| `calendar` | Calendar | The Day view on the event's date with the event selected: `setPrimaryView('calendar')` and a pending event id (a new store field, as `pendingOpenCardId`). |

- A source with no `url` and no `id` never reaches the client (`cleanSources` drops it).
- A chip's accessible name is "{title}, {kind}" and, for a web or Jira chip, ", opens in a new tab".

### 3.4 Checklist

- A fold "Checklist" with the count "{done} of {total}" in the faint voice. Open by default while
  the run is queued or in progress. Closed by default on a finished run. The user's choice holds
  for the session (per run id, in memory).
- Rows: 12.5 px, 5 px apart, a 16 px mark column, the text, and a right slot.

| `state` | Mark | Text | Right slot |
|---|---|---|---|
| `done` | 13 px circle, success-soft fill, a success check inside | muted | none |
| `doing` | 13 px filled accent circle with one halo ring (as the rail dot) | text colour, weight 500 | none |
| `todo` | 13 px hollow circle, strong border | text colour | none |
| `yours` | 13 px hollow circle, border in the blank voice (`--color-accent-3`) | text colour | "Yours", 11 px, weight 500, blank voice |

- The marks are state marks of a list, not icons before labels. The check is the one the plan
  rows use. No checkbox control: the user cannot tick an item (G1). A press on a row does nothing.
- The count counts `done` items over all items. "Yours" items count in the total.
- With no items, the fold does not render.
- The same list renders in the Details panel (section 7) through one component, `RunChecklist`.

### 3.5 The live line and the log

- The live line is one `ShimmerText` line in the working voice, as today. Its text is the first
  `doing` item, else the newest log line, else "In progress" (queued: "Starts soon").
- The log fold is unchanged: "What Albatross did" with the count. Lines keep their times. The
  live line is not repeated inside the open log.
- A steer note read by the run shows in the log as "Read your note: ..." (PR 3). The next message
  says what changed.

### 3.6 The end of a run

Order: the newest messages, the summary (only when the run has no messages), the blank sentence,
the package rows, "Not sure", the checklist (folded), the log (folded), the buttons.

**The blank sentence.** `BlankSentence` from `next.blanks`, 24 px, as today. With no blanks, the
fallback is `next.detail` at 19 px. It is the largest text of the handoff.

**Package rows.** A list with hairlines above and below (`divide-y`), one row per item of
`run.items`. With no items (an old run), the artifact rows render as today.

```
Invoice 0007 to Priya Natarajan                                  Draft
Check it. The three files are attached.
──────────────────────────────────────────────────────────────────────
Invoice 0007                                                  Document
Fill in rate. From the invoice template, 78 hours in July.
```

- Line 1: the title, 13 px, weight 500, one line with an ellipsis; the kind word at the right,
  11 px, faint.
- Line 2: the state in its voice, weight 500, then the note in the muted voice.
- The row is a button. A press opens the item: document mode with that tab active for `draft`,
  `document`, `sheet`, `deck`, and `file`; Notifications for `approval`; the Day view for
  `event`; a new tab for `page`. Hover turns the title to the accent colour, as the artifact rows.

| `item.state` | State text | Voice |
|---|---|---|
| `ready` | "Ready." | muted |
| `blanks` | "Fill in {names}." from `blankSentenceText(item.blanks)` | blank voice |
| `check` | "Check it." | blank voice |
| sent (client mark, draft only) | "Sent {time}." | success |

Kind words: Draft, Document, Sheet, Presentation, File, Approval, Event, Page.

**Not sure.** The label "Not sure", 12 px, weight 500, in the blank voice. Under it, one line
per entry of `run.unsure`, 12.5 px, with a 2 px left rule in `--color-accent-3-soft`. The blank
voice is the user's voice on these surfaces: these lines are the user's checks. With no entries,
nothing renders.

**Buttons.** `runBlockAction` gains one goal rule, and the labels change for goal runs:

| Run | Primary | Second | Quiet |
|---|---|---|---|
| queued, in progress | Stop | | |
| handed off, `ready_for_you`, items with a pane | the `next` label; fallback "Open the package" (one item: the kind fallback, as today) | Mark it done | Dismiss |
| handed off, `ready_for_you`, nothing to open | Mark it done | | Dismiss |
| handed off, `your_turn` on a page | `next.doneLabel` ("I paid"), default Continue | | Dismiss |
| handed off, `needs_answer` | none; the form has its button | | Dismiss |
| handed off, `stopped` (time or cost) | Continue | | Dismiss |
| failed | Try again (outline) | | |
| cancelled, closed | none on the block; the intro offers Handle it | | |
| done | none | | |

- "Open the package" opens document mode with one tab per item that has a pane, the
  `next.target` tab active. One item opens as today.
- "Mark it done" replaces "Mark step done" on goal runs. It posts the step route with
  `stepKey: 'goal'` and `continue: true`. The server proves the goal against the contract with the
  user's word and closes the Work by `closeWhen` (open question 1).
- A stopped goal run shows no "Handle it" (G6). The intro shows none either: a stopped run is an
  open handoff.

### 3.7 State matrix

| State | Header right | Messages | Checklist | Live line | Package | Not sure | Buttons |
|---|---|---|---|---|---|---|---|
| queued | Starts soon (working) | none | none | "Starts soon", or "Starts when a run ends" past the cap | | | Stop |
| running | In progress (working) | newest 6 open | open | doing item | | | Stop |
| needs answer | Needs your answer (waiting) | newest 3 open | folded | none | | | the form; Dismiss |
| handed off, package | Ready for you (waiting) | newest 3 open | folded | none | rows | lines | next, Mark it done, Dismiss |
| your turn (page) | Your turn (waiting) | newest 3 open | folded | none | rows if any | lines | doneLabel, Dismiss; the page row |
| stopped by limit | Stopped (quiet) | newest 3 open | open | none | rows if any | lines | Continue, Dismiss |
| failed | Did not finish (failed) | newest 3 open | folded | none | | | Try again |
| done | Done (done) | newest 3 open | folded | none | rows if any | | none; the proof line |
| cancelled | Stopped by you (quiet) | newest 3 open | folded | none | | | none |
| closed handoff | Closed · time (quiet) | newest 3 open | folded | none | rows with their last state | lines | none |

The stopped line reads "Albatross stopped at its time limit. The next run starts from the
checklist." (or "cost limit"). A failed run keeps "This run did not finish." and the error.

## 4. The thread around the block

### 4.1 The intro and the header line

- `PlanIntro` for a goal Work (`detail.goalRuns`): the outcome as the title, the summary, no plan
  strip. When the Work has done steps from before the change, a fold "2 steps done before this"
  lists them with `PlanSteps` (dense), each with its proof line. Singular: "1 step done before
  this".
- "Handle it" shows under the summary (28 px primary, `size="sm"`) when no run is open, no
  handoff waits, and the Work is open. It posts `{ action: 'start' }` with no `stepKey`. While a
  run is in progress or a handoff waits, the intro shows nothing more: the block carries it.
- `planLine` for a goal Work: the state word alone, no "Step N of M". Words: "Starts soon", "In
  progress", "Needs your answer", "Ready for you", "Your turn", "Stopped", "Did not finish",
  "Done", "Put down", and "Your move" when nothing is open. The pill opens Details as today.

### 4.2 The composer

- The route line while a goal run works: "To the run · {doing item}" from the first `doing`
  checklist item, else "To the run". `steerRunLabel` takes the checklist. The placeholder, "Ask
  instead", and "Stop and redirect" stay as PR 3.
- Placeholders by state are unchanged. In document mode: "Tell Albatross what to put in the
  document". On the draft tab: "Tell Albatross what to change in the mail".

### 4.3 Notes and receipts

Unchanged from PR 3. A note reaches the run; the run logs "Read your note"; the next message says
what it changed.

### 4.4 The rail and the list rows

- `in_progress` preview: the first `doing` checklist item, else the newest log line. The activity
  row gains `doing: string | null` from the run's checklist (open question 4).
- `ready_for_you` preview with a package: `packageLine(items)`: "{n} items: {title 1}, {title 2},
  ..." cut to the line. One item: `next.detail` as today. The row's `blanks` come from
  `next.blanks` as today.
- The hover action on a package row is the `next` label ("Open the package"), which opens the
  thread in document mode (`pendingThreadDocument` carries the tabs).

### 4.5 The Brief and the Documents page

- "Ready for you": the line is `packageLine(items)`; the button is the `next` label. It opens the
  Work thread in document mode, as the Documents page does today.
- "Waiting for you" on the Documents page: one row for each `document`, `sheet`, `deck`, or
  `file` item whose state is `blanks` or `check`. The row shows the item title, "Made for:
  {work}", the blank sentence (or the state line), and "Open", which opens that tab.

## 5. Document mode

### 5.1 Layout

```
┌ header: Back · title ·········································· Ready for you · Details · More ┐
│ ┌ document (center) ───────────────────────────────┐ ┌ thread (right, 460 px) ─────────────┐ │
│ │ Draft to Priya ● | Invoice 0007 ● | Hours | W-9 ●   Close │ │ Invoice 0007 · Document            │ │
│ │ Invoice 0007   Saved             Download  History  │ │ Fill in ____.                       │ │
│ │                                                      │ │       rate                          │ │
│ │   the editor, the PDF pane, or the composer          │ │ From the invoice template, ...      │ │
│ │                                                      │ │ [Done, continue]  Back to thread    │ │
│ │                                                      │ │ ──────────────────────────────────  │ │
│ │                                                      │ │ the thread: notes, replies          │ │
│ │                                                      │ │ composer                            │ │
│ └──────────────────────────────────────────────────────┘ └─────────────────────────────────────┘ │
```

`DocumentSplit` stays (64 / 36, the conversation at least 360 px). The thread column holds the
"Your part" card, then the thread.

### 5.2 Tabs

- A 38 px bar above the pane, `role="tablist"`, one `role="tab"` per item with a pane, in package
  order. The `next.target` item is first in the server's order and is the active tab on open.
- A tab is the item title (cut at 28 characters), 12.5 px. The active tab is weight 500 with a
  2 px accent underline. A tab whose item is `blanks` or `check`, and not yet done on this client,
  ends with a 6 px dot in the blank voice. A draft tab after send ends with "Sent" (11 px,
  success). "Close" (ghost, xs) sits at the right end.
- Up to 8 tabs. Past the width, the bar scrolls sideways and keeps the active tab in view.
- The active tab is kept per Work in `thread-memory.ts` (memory only), so a hop and back lands on
  the same tab.
- Document mode with one target (an old run, or an artifact row) shows no tab bar, as today.

### 5.3 Panes by item kind

| `item.kind` | Pane | Notes |
|---|---|---|
| `draft` | `DraftPane`: `InlineComposer` with `host="thread"`, prefilled from the saved draft as `openSavedDraft` does, plus `attachments` | Section 6. |
| `document` with `?office=` | `OfficeEditor` (Collabora), `host="thread"` | The blanks bind to the content controls (section 5.5). |
| `document` with `?document=` or a bare id | `DocumentEditor` (Albatross) | As today. |
| `sheet` | `OfficeEditor` | The Excel file in Collabora. |
| `deck` | `DocumentEditor` with the deck document | The shared slide renderer, as the deck preview. |
| `file` | `PdfPane` for `application/pdf`; the Files preview for images; a "Download" card for other types | Section 5.4. |
| `approval`, `event`, `page` | no tab | The package row opens them in place. |

In thread host the editors drop their back arrow: the tab bar's "Close" is the one way out. The
title, the save status, "Download", and "History" stay in the editor header.

### 5.4 The PDF pane

- `PdfPane` loads the saved file's bytes and renders each page to a canvas at the pane width
  (device pixel ratio aware), one canvas per page, and a page renders when it comes near the viewport. Fit to
  width only in v1; no text layer.
- Header, 44 px: the title (weight 500), "Page {n} of {m}" (updates on scroll), the size, then
  "Open in Files" (ghost) and "Download" (outline) at the right.
- Sealed fields: the pane reads the page annotations (`page.getAnnotations()`), finds each
  `sealedFields[].field` by its field name, and draws an overlay on its rectangle: the
  `--color-accent-3-soft` fill, a 1 px `--color-accent-3` border, and the label "Fills in when you
  send" above the first sealed field of a group (11 px, weight 500, blank voice). Fields without a
  rectangle show nothing; the card note still says it.
- A signature field left blank shows the same overlay with "Blank: sign it yourself, or send it
  without a signature."
- "Download" on a file with sealed fields runs the identity check (`useReverification`, the same
  as an allow), then downloads the filled bytes once. The button label stays "Download". A
  cancelled check shows "Not downloaded." under the header for one minute (quiet, 11.5 px).
- Errors: "The file did not open." with "Open in Files".

### 5.5 The "Your part" card

- Per active tab. Line 1: "{item title} · {kind word}", 11.5 px faint. Then the blank sentence
  for `item.blanks` (20 px), or nothing. Then `item.note` in the muted voice. Then "Done,
  continue" (primary) and "Back to thread" (ghost).
- The Word editor reads the content controls every 5 s (as it reads revisions). A filled control
  drops its name from the sentence. When every blank is filled, the card shows "All blanks are
  filled in." in the success voice instead of the sentence. The tab's dot goes.
- On the draft tab the note is the draft item's note; the card keeps the same two buttons. The
  Send button is in the composer, not on the card.
- "Done, continue" posts the step route with `stepKey: 'goal'` and `continue: true`, closes
  document mode, and focuses the composer. It is the same call as "Mark it done".
- With no open handoff for the item (an artifact opened from an old block), the card does not
  show; the tab bar still does.

### 5.6 Narrow screens (< 1024 px)

The document is full screen. The tab bar stays at the top and scrolls sideways. The "Your part"
bar at the bottom shows the active item's blank sentence (16 px) or its note (two lines), then
"Done, continue" and "Chat". "Chat" opens the thread as a sheet, as today.

## 6. The composer with attachments

- `DraftAttachment[]` rows render between the body and the bar, in the inline composer, the
  compose overlay, and the draft tab. One component, `AttachmentRows`.
- A row, 36 px: the name (12.5 px, weight 500, one line), the meta line (11 px, faint), and
  "Remove" (12 px, muted) at the right. "Remove" shows on hover and focus; on a touch screen it
  shows always. No remove glyph.
- Meta line: "{Kind} · {size}". Kind by `contentType` and `provider`: PDF, Word file, Excel file,
  Presentation, Image, File. An office file with `format: 'pdf'` adds "· From the Word file,
  converted when you send" (Excel: "From the Excel file"). A file with sealed fields adds a
  sentence in the blank voice: "The tax ID fills in when you send." (the field label from the
  item note; open question 2).
- "Remove" updates the draft (`update_draft` without that attachment) and shows a toast "Removed
  Form W-9.pdf" with "Undo" for 5 s.
- The bar: "Send" (primary), "Save the draft" (ghost), then "Attach a file" and "Add from Files"
  at the right (text). "Add from Files" opens the Files picker with the user's saved files and
  documents (open question 3).
- Send: the server reads the bytes from storage at send time (G3). The composer shows "Sending…"
  on the button, then the draft tab reads "Sent" and the package row "Sent {time}.". A send that
  fails shows the server's line under the bar in the danger voice.
- New browser files (`FileChip` today) and saved attachments show in the same list: a browser
  file's meta is "{Kind} · {size} · Not saved yet".

## 7. The Details panel

For a goal Work the Plan section is replaced by three sections at the top; Files, Proof,
Commitments, and Sources and assumptions stay.

| Section | Content | Empty copy |
|---|---|---|
| Checklist · {done} of {total} | `RunChecklist` with the newest run's list | "No checklist yet. It appears when a run starts." |
| Package · {n} | The package rows of the newest handoff, the same component as the block | "Nothing handed over yet." |
| Sources · {n} | Every source of the newest run, once, in order of first use, numbered: the title (12.5 px) and the kind line (11 px faint: "Mail · Priya Natarajan", "irs.gov"). Each row opens the source as a chip does. | "No sources yet." |

The plan document fold "Read the plan" does not show for a goal Work (no plan document). "Sources
and assumptions" from the plan stays for old Works.

## 8. Mobile web widths

| Window | Run block | Document mode | Composer rows |
|---|---|---|---|
| < 768 | Full width, 13 px side padding. Chips wrap. Package rows: the kind word moves under the title when the title is cut. Buttons wrap to two lines. | Full screen; tab strip scrolls; "Your part" bar at the bottom with "Done, continue" and "Chat". The PDF fits the width. The draft pane fills the width; the attachment bar wraps. | Rows full width; "Remove" always visible. |
| 768 to 1023 | 680 px column, as today. | As above (no split below 1024). | As desktop. |
| 1024 to 1279 | As today; the rail hides when a region or document mode is open. | The split, 64 / 36, conversation at least 360 px. | As desktop. |
| >= 1280 | As today. | As above. | As desktop. |

## 9. Keyboard, focus, screen readers, motion

- Chips are buttons in document order. "+N" is a button; after it opens, focus stays on it and the
  new chips follow in order.
- Package rows are buttons. Enter or Space opens the item. After document mode closes, focus
  returns to the row that opened it.
- The tab bar is one tab stop: Left and Right move, Home and End jump, Enter or Space
  activates. The option-command bracket keys (⌥⌘[ and ⌥⌘]) move between tabs from anywhere in
  document mode. Escape on the tab bar closes document mode. After "Open the package", focus
  lands on the active tab. After "Done, continue", focus lands on the composer.
- The checklist is a `ul` with `aria-label="Checklist, 2 of 7 done"`. Each row's accessible name
  ends with its state ("done", "in progress", "to do", "yours").
- The messages are a `section` with `aria-label="Messages"`. A new message announces once through
  the block's polite live region, merged with the state word; the checklist and the log never
  announce.
- "Not sure" is a `section` named "Not sure".
- The PDF pane: the canvases are `role="img"` with "Page 1 of 6"; PageUp and PageDown scroll one
  page; the sealed overlay has `aria-label="Social security number, fills in when you send"`.
- Reduced motion: no halo on the doing mark, the shimmer line is static (ShimmerText already
  checks), folds open without the slide animation, tabs switch without a transition.
- Dark mode: every colour is a token (`running-dark.png`). A PDF page and a Word page stay white
  paper in dark mode; the pane background is the well surface.

## 10. Copy

Sentence case, STE, no "AI", "assistant", or "agent". New strings for `GOAL_RUN_COPY` in
`lib/albatross/goal-run-view.ts`:

| Key | Text |
|---|---|
| `started` | Started {time} |
| `ran` | {start} · {duration} |
| `underMinute` | under a minute |
| `earlierMessages` | Earlier messages |
| `checklist` | Checklist |
| `checklistCount` | {done} of {total} |
| `yours` | Yours |
| `notSure` | Not sure |
| `itemReady` | Ready. |
| `itemCheck` | Check it. |
| `itemBlanks` | Fill in {names}. |
| `itemSent` | Sent {time}. |
| `kind.draft` ... `kind.page` | Draft, Document, Sheet, Presentation, File, Approval, Event, Page |
| `openPackage` | Open the package |
| `markDone` | Mark it done |
| `handleIt` | Handle it |
| `stoppedTime` | Albatross stopped at its time limit. The next run starts from the checklist. |
| `stoppedCost` | Albatross stopped at its cost limit. The next run starts from the checklist. |
| `closed` | Closed |
| `earlierSteps` | {n} steps done before this (1: 1 step done before this) |
| `packageLine` | {n} items: {titles} |
| `tabsClose` | Close |
| `tabSent` | Sent |
| `pdfPage` | Page {n} of {m} |
| `pdfDownload` | Download |
| `pdfOpenInFiles` | Open in Files |
| `pdfSealed` | Fills in when you send |
| `pdfSignature` | Blank: sign it yourself, or send it without a signature. |
| `pdfNotDownloaded` | Not downloaded. |
| `pdfFailed` | The file did not open. |
| `blanksFilled` | All blanks are filled in. |
| `draftPlaceholder` | Tell Albatross what to change in the mail |
| `attachRemove` | Remove |
| `attachRemoved` | Removed {name} |
| `attachUndo` | Undo |
| `attachFile` | Attach a file |
| `attachFromFiles` | Add from Files |
| `attachSealed` | The {field} fills in when you send. |
| `attachConverted` | From the Word file, converted when you send |
| `attachNotSaved` | Not saved yet |
| `send` | Send |
| `sending` | Sending… |
| `saveDraft` | Save the draft |
| `detailsChecklist` | Checklist |
| `detailsPackage` | Package |
| `detailsSources` | Sources |
| `noChecklist` | No checklist yet. It appears when a run starts. |
| `noPackage` | Nothing handed over yet. |
| `noSources` | No sources yet. |
| `documentsWaitingOpen` | Open |

Unchanged copy stays where it is: "Stop", "Continue", "Dismiss", "Try again", "What Albatross
did", "Done, continue", "Back to thread", "Chat", "Starts soon", "In progress", "Ready for you",
"Your turn", "Needs your answer", "Stopped", "Stopped by you", "Did not finish", "Done".

## 11. Component and file plan

New files:

- `lib/albatross/goal-run-view.ts` (pure): `isGoalRun(run)`, `GOAL_RUN_COPY`, `runHeaderLine(run,
  nowMs, timeZone)`, `visibleMessages(run, { working, open })`, `sourceChip(source)` (text, kind
  word, title attribute), `sourceBehaviour(source, items)`, `checklistCount(items)`,
  `liveLine(run)`, `packageRows(run)` (items, or artifacts on an old run), `itemStateLine(item)`,
  `packageLine(items)`, `packageTabs(run)`, `goalPlanLine(input)`, `earlierStepsLabel(n)`.
- `components/albatross/thread/RunMessages.tsx`: the messages, the "Earlier messages" fold, the
  chips (`SourceChips`), the "+N" overflow on the restyled `@ai-elements/sources`.
- `components/albatross/thread/RunChecklist.tsx`: the list and the fold; used by the block and
  the Details panel.
- `components/albatross/thread/PackageRows.tsx`: the rows; used by the block, the Details panel,
  and the Documents page row.
- `components/albatross/thread/NotSure.tsx`: the label and the lines.
- `components/albatross/thread/DocumentTabs.tsx`: the tab bar, the one tab stop, the keys.
- `components/albatross/thread/PdfPane.tsx`: the viewer, the sealed overlays, Download with the
  identity check.
- `components/albatross/thread/DraftPane.tsx`: the composer in the center with the saved draft.
- `components/thread/attachment-rows.tsx`: `AttachmentRows` and `attachmentMeta(attachment)`.
- `tests/albatross-goal-run-view.test.ts`, `tests/run-block-goal.test.tsx`,
  `tests/document-tabs.test.tsx`, `tests/pdf-pane.test.tsx`, `tests/attachment-rows.test.tsx`,
  `tests/package-rows.test.ts`.

Changed files:

- `components/albatross/thread/RunBlock.tsx`: the goal header, `RunMessages`, `RunChecklist`, the
  live line from `liveLine`, `PackageRows`, `NotSure`, the goal buttons.
- `lib/albatross/thread-view.ts`: `runBlockAction` goal rules (open the package, "Mark it done"),
  `planLine` for a goal Work, `threadStateInput` reads `detail.goalRuns`, `RUN_STATE_COPY.closed`
  with the time.
- `components/albatross/thread/PlanIntro.tsx`: the goal intro ("Handle it", the earlier steps
  fold), `PlanLine` without the step count.
- `components/albatross/thread/ThreadSteering.tsx`: `steerRunLabel` takes the doing item.
- `components/albatross/thread/DocumentPane.tsx`: `ThreadDocumentEditor` takes a tab and renders
  the pane by kind; `YourPartCard` and `YourPartBar` take an item; the filled-blanks line.
- `components/albatross/thread/DetailsPanel.tsx`: the Checklist, Package, and Sources sections for
  a goal Work; the Plan section only for a step Work.
- `components/albatross/WorkThread.tsx`: `document` becomes `{ tabs, activeKey }`; `onOpenItem`,
  `onOpenSource`, `onSelectTab`; "Handle it" with no step key; the compose prefill for the draft
  tab; the active tab in `thread-memory.ts`.
- `lib/albatross/document-handoff.ts`: `documentHandoffFor` matches package items; `DocumentTab`
  type; `documentAttachmentContext` names the open tab kind (a draft: "The user has this draft
  open ...", so the chat edits the draft with `update_draft`).
- `lib/albatross/step-run-client.ts`: `NextBehaviour` gains `open_file` and `open_package`;
  `artifactBehaviour` handles `file` and `deck`; `documentTargetOf` learns `?file=` as
  `{ provider: 'upload' }`; `readyForYouRows` and `documentsWaitingRows` read `items`.
- `lib/albatross/step-run-navigation.ts`: `open_file` and `open_package`.
- `lib/albatross/threads.ts` and `convex/albatrossThreads.ts`: `runActivity` gains `doing` and
  `items` (title and state only); the preview uses `packageLine`.
- `lib/albatross/thread-list-view.ts`: the row action label for a package.
- `components/report/ReadyForYou.tsx`, `components/files/DocumentsWaiting.tsx`: the package line
  and the per-item rows.
- `components/thread/InlineComposer.tsx`: `host`, `attachments`, `onAttachmentsChange`,
  `AttachmentRows`; the send body carries `attachments`.
- `components/files/OfficeEditor.tsx`, `components/files/DocumentEditor.tsx`: no back arrow when
  `host="thread"` and a tab bar is present (`hideClose` prop).
- `lib/client-state.ts`: `pendingThreadDocument` carries `{ workId, tabs, activeKey }`; a pending
  calendar event id for calendar sources.
- `lib/albatross/thread-memory.ts`: `threadTab(workId)` and `setThreadTab(workId, key)`.
- `components/odysseyui` and `components/ai-elements/sources.tsx` (installed, restyled).

Fixtures (`lib/albatross/thread-fixtures.ts`), all invented:

- `goalDetailFixture(now)`: the Bramble Press Work, `goalRuns: true`, a plan row with zero
  actions, the contract (outcome: the invoice mail is sent with the three files). A variant
  `goalDetailWithEarlierSteps(now)` with two done steps.
- `goalRunFixtures(now)`: `goalQueued`, `goalRunning` (7 messages, 7 checklist items, 14 log
  lines), `goalNeedsAnswer` (a one-field form: which address for Priya), `goalPackage` (11
  messages, 4 items, 2 unsure lines, `next.blanks: ['rate']`), `goalYourTurn`, `goalStoppedTime`,
  `goalFailed`, `goalClosedPackage`, `goalDone` (continued, the proof).
- `goalSourceFixtures`: one source of each kind.
- `goalDraftFixture(now)`: the saved draft with three `DraftAttachment` rows, one with a sealed
  note.
- `invoiceOfficeFixture`: the office document metadata for the invoice tab (the harness shows a
  stub pane "The Word editor needs the document server." with the blank sentence, because
  Collabora does not run in the harness).
- `w9SampleFixture`: a small PDF with text fields and one sealed field. It is a sample form that
  looks like a W-9 with invented values, under `public/dev/w9-sample.pdf`. Its bytes are written
  by a script with `pdf-lib` (open question 5).

Harness (`app/dev/thread-preview/page.tsx`): new states `goalRunning`, `goalNeedsAnswer`,
`goalPackage`, `goalDocument` (with `&tab=draft|invoice|hours|w9`), `goalStopped`, `goalFailed`,
`goalDone`, `goalDetails`, `goalEarlierSteps`, and `&dark=1`. The fetch stub serves the office
metadata, the draft, and the sample PDF. The `threads-preview` rail gets one package row and one
goal run in progress with the doing line.

Tests: the view helpers (header line, visible messages and the fold counts, chip text and
behaviour by kind, the live line order, package rows from items and from artifacts, the state
lines, the package line, the tabs order and the active key, the goal plan line, the goal button
rules, old step runs unchanged); the block renders each state from the fixtures; the tab bar keys
and focus; the PDF pane finds sealed fields by name and gates Download; the attachment rows meta
and Remove with Undo; the Details sections and empty copy; the rail preview for a package; Ready
for you and Documents waiting rows from items.

## 12. The mockup

- Source: `/tmp/goal-runs-web-mockup/index.html`, one file, switched by `?screen=running`,
  `package`, `details`, `document`, `pdf`, `draft`, `stopped`, `failed`, `done`, `mobile`,
  `mobile-pdf`, and `&dark=1`. Tokens are copied from `app/globals.css` (light defaults and the
  `:root.dark` block, accent hue 156, depth 1, tint 0). Fonts are the repo's Geist and Fraunces.
  The invoice page uses the template tokens from G4 (Fraunces title and total, Geist body, ink
  1F1D1A, muted 6B665D, rule D9D3C7, accent AE4B2B, tint F6E9E3).
- Renderer: `/tmp/goal-runs-web-mockup/shoot.mjs` with the worktree's `playwright-core` 1.62.1.
  1440 x 900 and 390 x 844 at 2x.
- Three iterations: (1) the icon rail painted across the top because the desktop screens lacked
  the app grid; (2) the document header's "Download" and "History" stacked because its `.right`
  class collided with the right column's rule; (3) a "Secure" source chip was removed because the
  contract has no such kind and the secure store never shows as a source; the lone message time
  stamp went, the superseded handoff reads "Closed", and the mobile tab strip scrolls the active
  tab into view.

## 13. Open questions for the lead

1. **"Mark it done" and "Done, continue" on a goal Work.** Both post the step route with
   `stepKey: 'goal'` and `continue: true`. Recommendation: the server proves the goal against the
   contract with the user's word (`source: 'user'`), closes the open handoffs, and closes the Work
   by `closeWhen`. With nothing left, no run starts.
2. **The sealed note on a draft attachment.** `DraftAttachment` has no sealed flag. The composer
   can read the item note by `fileId` from the package while the thread is open, but the compose
   overlay cannot. Recommendation: add `sealed?: boolean` and `sealedNote?: string` (the server
   writes them from the file's sealed fill list).
3. **"Add from Files".** Recommendation: ship it in this round as a small picker of the user's
   saved files and documents, because the W-9 story needs a saved file on a draft. If the round
   is too large, ship "Attach a file" only and keep the package attachments the run made.
4. **The activity row.** The rail preview of a goal run in progress wants the `doing` checklist
   item, and a package row wants the item titles. Recommendation: `runActivity` gains
   `doing: string | null` and `items: Array<{ title, state }>` (titles only, no ids).
5. **The sample PDF fixture.** `pdf-lib` is not a dependency. The server's `pdf_form_fill` needs a
   PDF writer; recommendation: add `pdf-lib` and write the sample with a script, committed as a
   small file under `public/dev/`. The harness never fetches a real IRS form.
6. **How a message renders.** Recommendation: plain text with line breaks. The prompt tells the model
   to write prose, not Markdown. If a message arrives with Markdown, it shows as written.
7. **Numbered citations.** The contract attaches sources to a message, not to a sentence. The
   Details Sources list numbers them for the list. Recommendation: no inline numbers in this round.
8. **How many messages stay open.** Recommendation: 6 while the run works, 3 after it ends, the
   rest under "Earlier messages". A 40-message run then reads as a few paragraphs, not a wall.
9. **A sent draft on the package row.** The run row does not change when the user sends. The
   client marks the row "Sent {time}." for the session; the continued run's proof is the record.
   Recommendation: accept the client mark; the server can update the item state later if wanted.
10. **The draft tab and the office editor chrome.** Recommendation: the tab bar's "Close" is the
    one way out of document mode; the editors hide their back arrow in thread host when a tab bar
    is present.
11. **The calendar source.** Opening an event needs a pending event id in the client store, as a
    card has. Recommendation: add it; until then a calendar chip opens the Day view on the date.
12. **Tab keys.** ⌥⌘[ and ⌥⌘] for the tabs keep clear of ⌘↑ / ⌘↓ (hops) and the browser's ⌘1 to
    ⌘9. Recommendation: accept; no digit shortcuts.
