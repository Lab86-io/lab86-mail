# The Albatross thread, macOS design note (2026-10-07)

Status: design, no code. The product brief is `docs/albatross-thread.md`. The contract is
`lib/albatross/thread-contract.ts`. The earlier Mac note for the step runner is
`step-runner-macos-design-2026-10-07.md`; this note replaces its Work page decisions and keeps
its browser, keyboard, and Brief decisions. The iOS note,
`albatross-thread-ios-design-2026-10-07.md`, owns the shared SwiftUI views and their copy. This
note decides only what the Mac adds: the window, the trailing pane, the toolbar, the keyboard,
the pointer, and the Settings rows. Where this note and the iOS note name the same view, the
iOS note wins; section 3 lists the hooks the Mac asks for.

Sample data in this note is invented: "Sam Rivera", `sam.rivera@example.com`, "(555) 010-0100",
and "12 Harbor Lane, Apt 4, Portland, ME 04101". The classes are the iOS note's set: Monday
October 19 and Wednesday October 21 at 4:00–8:00 PM, and Saturday October 24 at 9:00 AM–1:00 PM,
all on Zoom, all $70.

## What went wrong on the Mac today

The Mac Work detail has the same structure as the web Guided work page in Jakob's screenshots.
On the Mac it shows these problems:

- The step card, the handoff card, and the floating chat panel each carry their own
  "Continue" and "Discuss this". One page, three voices.
- The floating chat panel (`MacChatPanel.swift`, 360 by 480 points) covers the live browser. The
  user must read the form under it.
- The live pane (`MacStepRunLivePane.swift`) sits inside the "Do this next" section, so it scrolls
  away with the page. A live page must not scroll.
- The run cannot read what the user wrote in the chat. The chat cannot touch the run.
- Nothing on the Mac knows the user's name, phone, or address.

## What the Mac must do differently from iOS

- A Mac window is wide. The conversation and the page sit side by side, and nothing floats over
  either one.
- A Mac has one trailing pane, as Keynote and Xcode do. The pane shows the page or the details,
  never both.
- A Mac has a keyboard. One key sends. One key stops. One key does the one action that waits.
- A Mac has a pointer. Rows show a hover fill and a context menu. Nothing important hides
  behind a hover.
- A Mac sheet takes the size of its content. The page sheet names a size for a narrow window.
- Settings is a sheet with a grouped form. An editor pushes inside that sheet, never a second
  sheet.

## 1. Research

Mobbin has no macOS filter. The desktop screens below are web screens at a desktop width. Each
line says what the Mac takes and what it rejects, and which decision it drives.

### Mobbin screens (desktop)

Conversation beside a live surface:

- Lindy, computer-use chat ([screen](https://mobbin.com/screens/9f4affd5-f387-4149-860e-95c83f9bbba5)).
  The chat is the left column. A "Start computer" row sits in the transcript. The right pane
  has "Browser" and "Terminal" tabs and a close control. Taken: the page is a pane beside the
  conversation, and the run announces the page as a row in the transcript. Rejected: the pane
  tabs; the Mac pane switches between the page and the details with toolbar toggles, not tabs
  inside the pane. Drives decisions 2.1 and 2.3.
- Cursor, cloud agent with the live desktop ([screen](https://mobbin.com/screens/b3ac00e6-3ed4-4650-8adf-f146abb6f676)).
  The transcript is the middle column. The right pane shows the live desktop with one "Take
  control" button over it. Taken: one hand-over control in the pane. Rejected: the floating
  button over the content; the Mac puts it in the pane bar, so it never covers a form field.
  Drives decision 5.1.
- Cursor, run summary with files ([screen](https://mobbin.com/screens/cb7068e4-44d5-4f04-9c5c-855782a96309)).
  "Worked for 27s", a summary, then "7 Files Changed" as rows. The right pane shows the diff.
  Taken: the run block order (summary, files, log) and the details pane as the place for the
  files. Rejected: the walkthrough video. Drives decisions 3.2 and 5.3.
- Cofounder, workspace ([screen](https://mobbin.com/screens/d7d5d911-1ce1-4d24-ba23-e9e8cbfbe659)).
  "Ran 35 actions" collapses the log. "What shipped" and "Verified" follow in the chat. The
  left pane has Preview, Changes, Replay, and Scratchpad tabs. Taken: the collapsed log after a
  run ends. Rejected: the workspace pane at the left; the conversation keeps the leading
  position on the Mac because the sidebar is already there.
- Plain, side session pane ([screen](https://mobbin.com/screens/e1cfb6cf-0dd0-4576-b19d-484ad8f8f483)).
  A side pane with its own composer, "esc" to close. Rejected: a second composer. The Mac has
  one composer, in the conversation. Drives decision 2.1 (one voice).
- Emergent, chat with a right "Manage" pane ([screen](https://mobbin.com/screens/0d515547-8a56-4638-b1b6-8f8da53846b3)).
  "Agent has been paused" is a row in the transcript. Taken: a stop or a limit is a line in the
  run block, not a banner. Rejected: the credits bar. Drives decision 5.3.

Forms in the conversation:

- Gumloop, "Asking for your input" ([screen](https://mobbin.com/screens/a0c0e7b0-88bb-4a89-904a-d88ee892a8dd)).
  A form card in the transcript: a title, a help line, radio rows, "Reject" and "Submit". The
  details pane at the right lists Source, Created, Model, and Files. Taken: the form card with
  the submit at the trailing edge, and the details pane with Files. Rejected: "Reject"; a
  runner question has no skip, and a chat form has a quiet "Not now". Drives decisions 3.3 and
  5.2.
- Unify, numbered choice form ([screen](https://mobbin.com/screens/66df7194-18ef-479e-9679-03955deba055)).
  Each option shows a number key at the trailing edge. "Submit" shows its shortcut. Taken: the
  submit button shows ⌘↩ in its help text, and Full Keyboard Access reaches every row.
  Rejected: number keys for options; a Mac text field already owns the digit keys.
- Obvious, in-chat question with a recommended option ([screen](https://mobbin.com/screens/c4e3df56-6a0d-42e2-ad0e-04b583839729)).
  One option carries "Recommended". Taken: the first option is the one that matches what the
  user said, and the calendar note is the reason, not a badge. Drives S9.
- Customer.io, radio form in chat ([screen](https://mobbin.com/screens/710cdb95-39d9-4833-9f83-909616128d51))
  and Base44 ([screen](https://mobbin.com/screens/c1c8ed46-61fe-4495-b04f-3db81b65a3f6)).
  Radio rows with a one-line detail under each label, and "Something else" as the last row.
  Taken: the detail line under each option and the "Other" row. Rejected: the "1/3" pager; a
  Mac form shows all fields at once.
- WRITER, "Waiting for your input" ([screen](https://mobbin.com/screens/457724a4-6959-4268-819e-b1e29ff0b0bd)).
  A text question with a numbered list of what to provide. The user answers in the composer.
  Taken: the composer answers a form (S11). The form then shows "Answered in the chat."
- Discord poll ([screen](https://mobbin.com/screens/9c690ea5-066c-4b45-9e4a-f48ada104f13)),
  Microsoft Teams poll ([screen](https://mobbin.com/screens/25b9b7ac-cfdf-49e6-91be-1e9915bcaeb3)),
  WhatsApp poll ([screen](https://mobbin.com/screens/1eb153f9-8ac7-4450-b073-0604fe825a8a)).
  Rejected: polls are shared votes, not a private answer. Mistral feedback chips
  ([screen](https://mobbin.com/screens/7115d8a6-ff0f-443a-816b-e0355285d0d8)) rejected: chips
  hide the detail line each option needs.

Three columns with a details pane:

- Intercom inbox ([screen](https://mobbin.com/screens/eafa74c2-8bfe-4729-8b1e-cde0ca455153)).
  Sidebar, list, conversation, and a "Details" pane at the right with Links and Attributes.
  Taken: the pane title "Details", and grouped sections with a disclosure each. Rejected: four
  columns; the Mac has three.
- Linear issue ([screen](https://mobbin.com/screens/16e4d0c7-bf36-4daa-98f5-d3d31882cfec))
  and project ([screen](https://mobbin.com/screens/1a4540b2-6c15-49ff-a07f-4fddb7490e38)).
  A fixed-width properties pane at the right, with Properties, Milestones, Progress, and
  Activity sections. A toast at the bottom right says "Issue created" with "View issue". Taken:
  the section order (plan, files, proof, commitments) and the quiet receipt with one link.
  Rejected: the 320-point width; the Mac pane holds a document, so it keeps the page width.
  Drives decisions 2.2 and 5.2.
- Telegram, user info pane ([screen](https://mobbin.com/screens/e0cbc019-0abb-4e7b-b7d9-4d9b363e6f98)).
  A detail pane with a close control in its own header. Taken: the pane has its own header
  with a close control. Rejected: the avatar block.
- Pipedrive live chat ([screen](https://mobbin.com/screens/ee2d46f5-db18-4351-97a2-1243e63b555e))
  with empty "Person" rows (Name, Email, Phone). Taken: empty rows say what is missing; the
  Personal details page lists the missing fixed keys as rows with "Add".
- Airbnb reservation pane ([screen](https://mobbin.com/screens/35c5c3c1-b857-4da4-b73a-f3029e48fab0)).
  The pane shows "Changes pending" with "Show request". Taken: a pending commitment is a row
  with one link.

Plan line and step list:

- Mistral, research plan card ([screen](https://mobbin.com/screens/2a5b2f2d-b686-4ee8-8eb6-356285a178b2)).
  The plan is a numbered list in one card with "Edit" and "Start research" and their shortcuts.
  Taken: the outcome block for a new Albatross (S2), with "Handle it" on the current step.
  Rejected: the time estimate.
- Manus, task done ([screen](https://mobbin.com/screens/db51dd55-0e37-4edd-a20c-c0308ad42760)).
  A collapsed step line "Deliver the final presentation 3/3" sits over the composer. Taken: the
  plan line with "Step 1 of 2" and the state. Rejected: the line over the composer; the Mac
  puts it in the toolbar, where the pointer finds it and the transcript keeps its measure.
  Drives decision 2.3.

Personal details:

- Cloaked, Personal information ([screen](https://mobbin.com/screens/b030f7c0-6780-42d9-bb8e-cc9131767780)).
  "Cloaked can save and fill your information for an easier browsing experience." Then
  Street, Apartment, City, State, Zip, Country. Taken: the one-line reason at the top, and the
  address fields. Drives section 6.
- Salesforce, Personal Information ([screen](https://mobbin.com/screens/cd97b10b-adad-4874-98a9-8cdbc15d2331)).
  Rejected: the dense columnar form; a Mac grouped form is the idiom.
- Turo, Account ([screen](https://mobbin.com/screens/2af08f73-1084-422b-850e-451f0ab88572)).
  The phone row shows the number, "Verified", and one "Update" button at the trailing edge.
  Taken: value at the left, source caption, one trailing "Edit" button. Drives section 6.
- Zoom, personal information ([screen](https://mobbin.com/screens/1908a96e-9920-4ce5-bc7b-660da6f64091)).
  A Phone row with "Edit" and "Delete" at the trailing edge. Taken: delete is on the editor
  page, not on the list row, so one trailing control per row. Rejected: two controls per row.
- TravelPerk, edit personal ([screen](https://mobbin.com/screens/41af3e8c-7032-410d-aecd-ee1da39e511a)).
  "Only visible to your company and TravelPerk" at the bottom. Taken: a footer that says what
  Albatross never keeps.

Receipts with Undo: the search returned delete dialogs only
([Slack](https://mobbin.com/screens/b4ca939d-97db-404a-9736-fe181dcf56f0),
[Discord](https://mobbin.com/screens/603927d2-c643-44a1-9a41-802e3ecb8a35)). Rejected: a
dialog for a reversible save. The Mac uses the Linear receipt pattern above and the shell's
existing undo notice with Edit > Undo (`MacUndoBridge`).

### Product behaviour (Browserbase fetches)

- Claude in Chrome, get started ([support.claude.com, article 12012173](https://support.claude.com/en/articles/12012173-get-started-with-claude-in-chrome)).
  The side panel "stays visible while you browse". It starts in "Automatically approve":
  Claude works, reviews each action, and "pauses to ask you when something needs your
  approval". Sessions save and move between surfaces. Taken: the pane stays open while the run
  works; a question is a pause with one form; the thread is one saved session.
- Claude in Chrome, permissions guide ([support.claude.com, article 12902446](https://support.claude.com/en/articles/12902446-claude-in-chrome-permissions-guide)).
  Claude still asks before "entering potentially sensitive information into a page" and never
  makes purchases. Taken: the boundary copy. Personal details are not sensitive in this
  product (the owner decided); payment, passwords, and codes are. The run says which it typed.
- ChatGPT agent ([help.openai.com, article 11752874](https://help.openai.com/en/articles/11752874-chatgpt-agent))
  returned a bot wall again on 2026-10-07. The ChatGPT Atlas article
  ([allthings.how](https://allthings.how/chatgpt-atlas-agent-mode-macos-setup-controls-workflows/))
  records the Mac behaviour: Atlas reports progress in the sidebar while it acts in the tab,
  and it "pauses for approval on sensitive surfaces". Logged-in and logged-out scopes are a
  user choice. Taken: progress lines in the run block while the page moves in the pane.
  Rejected: the scope choice; saved sign-ins already cover it.
- Apple HIG, split views ([developer.apple.com](https://developer.apple.com/design/human-interface-guidelines/split-views)).
  macOS: "Set reasonable defaults for minimum and maximum pane sizes", "Consider letting people
  hide a pane", "Provide multiple ways to reveal hidden panes" (a toolbar button and a menu
  command with a shortcut), "Prefer the thin divider style". Keynote is the named example of a
  split view with an inspector. Taken: every pane has a toolbar toggle, a View menu item, and a
  shortcut; the divider is thin.
- Apple HIG, sheets ([developer.apple.com](https://developer.apple.com/design/human-interface-guidelines/sheets)).
  A macOS sheet is always modal. "Display only one sheet at a time." "Use a panel instead of a
  sheet if people need to repeatedly provide input and observe results." Taken: the page is a
  pane, not a sheet, when the window is wide; the editor for a personal detail pushes inside the
  Settings sheet instead of a second sheet.
- Apple HIG, popovers ([developer.apple.com](https://developer.apple.com/design/human-interface-guidelines/popovers)).
  "Consider using popovers when you want more room for content." macOS popovers can detach into
  a panel. "Avoid using a popover to show a warning." Taken: the plan steps open in a
  detachable popover from the plan line; the narrow-window Details view is a detachable
  popover; no warning uses a popover.
- Apple HIG, settings ([developer.apple.com](https://developer.apple.com/design/human-interface-guidelines/settings)).
  Command-Comma opens settings. "Minimize the number of settings." Taken: Personal details is
  one row in the existing Settings sheet, not a new window.
- Apple HIG, keyboards ([developer.apple.com](https://developer.apple.com/design/human-interface-guidelines/keyboards)).
  "Support Full Keyboard Access." "Don't repurpose standard keyboard shortcuts." List modifiers
  in the order Control, Option, Shift, Command. Taken: no new shortcut reuses a standard one;
  Command-period stays "stop" as in Safari.
- Apple HIG, toolbars ([developer.apple.com](https://developer.apple.com/design/human-interface-guidelines/toolbars)).
  The trailing edge holds "buttons that open nearby inspectors" and the More menu. "Only
  specify one primary action, and put it on the trailing side." Taken: the Page and Details
  toggles sit at the trailing edge before the menu; the plan line sits after the title at the
  leading edge.
- Apple HIG, sidebars ([developer.apple.com](https://developer.apple.com/design/human-interface-guidelines/sidebars)).
  "Consider automatically hiding and revealing a sidebar when its container window resizes."
  Taken: the sidebar collapses first when the pane needs room.
- SwiftUI `inspector(isPresented:content:)` ([developer.apple.com](https://developer.apple.com/documentation/swiftui/view/inspector(ispresented:content:)))
  and `inspectorColumnWidth(min:ideal:max:)` ([developer.apple.com](https://developer.apple.com/documentation/swiftui/view/inspectorcolumnwidth(min:ideal:max:))).
  An inspector "can present as a trailing column" and "Trailing column inspectors have their
  presentation state restored by the framework". The width is a preference; "Only some
  platforms enable flexible inspector columns". Taken: one inspector with one width band for
  both modes, so the restored width never fights a mode change. The iPad takes the same
  modifier (iOS note, 7.2), so one `PagePaneView` serves both. See open question 2.

## 2. Window structure

### 2.1 Three columns, one voice

The Work thread replaces `WorkDetailView` as the `navigationDestination` for `workRoute` in
`WorkView.swift` and `AreaDetailView.swift` (iOS note, 2.1). On the Mac the destination is
`MacWorkThreadView`. The window keeps the existing `NavigationSplitView` shell
(`MacShellView.swift`): the source list at the leading edge, and the detail column. The thread
adds a trailing pane inside the detail column with `.inspector(isPresented:)`.

```
sidebar (220–340) | conversation (min 480) | trailing pane (460–760, page or details)
```

- The conversation is the detail column's content. The composer docks at its bottom edge
  (`safeAreaInset`), as `AssistantChatView` does today. Text keeps a reading measure of 720
  points; the column may be wider, and the content centers.
- The trailing pane shows the page or the details, never both. The page takes the pane when a
  run opens a site. The user can switch to the details at any time; the page keeps its session.
- The floating chat bubble (`MacChatOverlay`) hides while a Work thread is on screen. The thread
  is the conversation. Command-K focuses the thread composer instead of the bubble.
- The torn-out chat window (`MacChatWindowRoot`) stays for global and Area chats. It never shows
  a Work thread. `startAssistantChat(scope: .work)` routes to `openWork` (iOS note, 2.1).

### 2.2 Widths and breakpoints

`D` is the detail column width (window width minus the sidebar). One width band serves both
pane modes, so the inspector's restored width is always valid.

| Condition | Layout |
|---|---|
| D ≥ 960 | The pane may open beside the conversation, in page mode or details mode. Pane width = 52% of D, clamped 460–640; the user may drag between 460 and 760. Conversation keeps ≥ 480. |
| D < 960, window ≥ 960, sidebar shown | The sidebar collapses first (`columnVisibility = .detailOnly`), then the pane opens. The sidebar returns when the pane closes, unless the user hid it. |
| D < 960 and no room | No pane. Details opens as a detachable popover (360 wide) from the toolbar toggle. The page opens as a sheet. |

The page sheet (`.macSheet(.liveBrowser)`) names 1180 by 760. A narrow window cannot hold that.
The Mac clamps the sheet to the window: width = min(1180, window − 48), height = min(760,
window height − 48). This is a change to `MacSheetChrome.swift`.

The threshold keeps PR #319's rule: the live pane needs a 960-point detail column.

### 2.3 Toolbar

The detail column's toolbar, leading to trailing:

| Item | Placement | What it is |
|---|---|---|
| Title | `navigationTitle` | The outcome: "Register for the Alive at 25 course". The title truncates in the middle and the full text sits in `help`. |
| Plan line | `.navigation` placement, after the title | A plain text button: "Step 1 of 2 · Your turn ⌄". A click opens the plan popover (S3). The words come from the iOS note's plan-line table. |
| Page toggle | `.primaryAction` group, first | `Label("Page", systemImage: "globe")` with `.labelStyle(.iconOnly)`. Help: "Show the page (Control-Command-P)". A 6-point dot at the glyph's corner while a session is live and the pane is closed or in details mode: accent-2 when Albatross has the page, accent when it is the user's turn. Dimmed when no session exists. |
| Details toggle | `.primaryAction` group, second | `Label("Details", systemImage: "sidebar.trailing")`, icon only. Help: "Show the details (Control-Command-I)". |
| Menu | `.primaryAction` group, last | `ellipsis.circle`: "Split…", "Put it down" or "Pick it up", "Set horizon…", "Mark done", divider, "Archive…". "Details" is not in the Mac menu; the toggle is the control. |

The two toggles act as a pair: one on, or none. The system toolbar hover and selection
appearances apply. The toggles carry no text; the Mac toolbar idiom is a glyph, and the no-icon
rule is for buttons with text in the content.

The plan line is text on purpose. It is the one item the pointer must read without a tooltip.

### 2.4 The narrow window

Below D = 960 with no room to collapse, the window is one column:

- The plan line stays in the toolbar.
- The run block shows the page row (section 5.3) with "Open", which opens the clamped sheet.
  Return in the sheet is the done label or "Continue"; Command-period is "Take over"; Escape
  closes it (unchanged from the step runner note).
- The Details toggle opens a detachable popover. The popover holds `WorkDetailsBody` in a
  scroll view, 360 wide, up to 560 tall. A drag detaches it into a panel that stays while the
  user reads the conversation.
- The composer and the forms do not change.

### 2.5 A separate window for the page (optional, phase 2)

The pane's small menu (the chevron after "Larger view") gains "Open in its own window". It
opens a `Window("Page", id: "albatross-page")` scene on the same session row, as
`MacChatWindowScene` does for the chat. While that window is open, the pane in the main window
closes and the Page toggle's help reads "The page is in its own window". When the window closes,
the pane returns if the session is still live. This is phase 2: the pane ships first.

### 2.6 Keyboard shortcuts

| Key | Where | Action |
|---|---|---|
| Return | Composer | Send. Shift-Return inserts a line. Return never starts a run by itself; "go ahead" is a message, and the run starts from the reply. |
| Return | A form field | Submit the form. The form's submit is the window default only while a form field has focus. |
| Command-Return | Anywhere in the thread | The one action that waits: the newest handoff's primary button, or the newest form's submit. The button's help shows "⌘↩". |
| Command-period | Anywhere in the thread | Stop the open run. The page stays with the user. While no run is open and a reply streams, it stops the reply. |
| Control-Command-P | Anywhere | Show or hide the page pane. Also in the View menu. |
| Control-Command-I | Anywhere | Show or hide the details pane. Also in the View menu. |
| Control-Command-S | Anywhere | Show or hide the sidebar (system). |
| Command-K | Thread on screen | Focus the composer. Elsewhere it toggles the chat bubble, as today. |
| Command-Z | After a receipt | Undo the last "Saved to your details" (through `MacUndoBridge`). |
| Shift-Command-H | Thread on screen | Horizon popover (unchanged). |
| Escape | A popover or the page sheet | Close it. Escape never stops a run and never closes the pane. |
| Tab | Everywhere | Full Keyboard Access order: toolbar, plan line, the newest block's controls, composer, pane bar, pane content. |

"Handle it" and "Try again" keep no shortcut. A run costs money, and one key press must not
start one (step runner note, decision 4).

Shortcut names go in `ShortcutReferenceView.swift` and in the View menu through
`AlbatrossCommands.swift`.

### 2.7 Pointer and hover

- A run block shows a quiet fill on hover only on its rows (artifacts, the page row), not on the
  whole block. Hover on the summary reveals "Copy" at the trailing edge with no reserved space.
- Context menu on a run block: the primary action, "Continue" (when it applies), "Copy the
  summary", "Copy the log", divider, "Dismiss". "Discuss this" is gone: the conversation is the
  discussion.
- A form option row: hover fill; the selected row draws a 1-point accent border; the calendar
  note stays at the trailing edge; a conflict is red, as on iOS.
- The plan line: the chevron darkens on hover. Click opens the popover.
- The page pane bar: "Take over" and the done label are always visible, never hover-only. A
  hand-over control must not hide.
- Log lines: the time is always visible (56-point column). Hover on a line shows the full date
  and time in a tooltip.
- A live page under the pointer: the live view accepts clicks as today. The first click while
  Albatross has the page shows one line in the bar for three seconds: "Albatross still has the
  page. Press Take over to act yourself." No modal, no block. See open question 6.

### 2.8 Focus

- The system focus ring stays on every control and option row.
- The composer field turns its own ring off (`focusEffectDisabled`) and the glass container draws
  a 2-point accent ring at the same prominence, so the ring follows the capsule shape.
- When the thread opens, focus goes to the composer unless a form waits; then focus goes to the
  first empty field of the newest form.
- When a form submits, focus returns to the composer.
- When the page pane opens from a run event, focus does not move. The user keeps the composer.

## 3. Shared and Mac-only code

### 3.1 What the Mac reuses (from the iOS note, section 3)

Shared, platform-neutral:

- Models: `ThreadModels`, `ThreadTimeline`, `PersonalDetailsModels`, `PersonalDetailsStore`,
  `WorkThreadStore`, `WorkThreadModel`.
- Views: `OutcomeBlockView`, `RunBlockView`, `RunChainView`, `FormQuestionCard`,
  `FormFieldViews`, `FormValidation`, `PlanListView` (the plan sheet content),
  `WorkDetailsBody` (the details sheet content), `PagePaneView` (the page bar, the live view, and
  the placeholder states; the iPad inspector uses it too), `PersonalDetailsSettingsView` and
  `PersonalDetailEditorView`.
- The split of `AssistantChatView` into `AssistantTranscriptRows` and `AssistantComposer`.
- The `personal_details_saved` shape card in `AssistantShapeCards.swift` (the receipt row).
- The copy tables of the iOS note.

iOS only: `WorkThreadView` (the iPhone screen), `PlanSheet`, `DetailsSheet`, `PageSheet` as a
sheet. The Mac keeps `PageSheet` for the narrow window only.

The Mac keeps from PR #319: `StepRunBrowserPresentation`, `StepRunCopy`, `MacSheetSize`,
`MacReadyForYouRow`, `SavedSignInsView`.

### 3.2 Mac-only files

| File | What it holds |
|---|---|
| `Lab86MailMac/Work/MacWorkThreadView.swift` | The Mac screen for `workRoute`. Hosts `OutcomeBlockView`, `AssistantTranscriptRows`, `RunBlockView` and `RunChainView`, `FormQuestionCard`, and `AssistantComposer` in the detail column; `.inspector(isPresented:)` with `MacThreadPane`; the toolbar; the sidebar collapse; the focus rules; the auto-open rule. |
| `Lab86MailMac/Work/MacThreadLayout.swift` | The pure rules: `MacThreadPaneMode` (`none`, `page`, `details`), `allowsPane(width:)`, `paneWidth(for:)`, `collapsesSidebar(windowWidth:sidebarShown:)`, `paneAfterRunEvent(current:event:trigger:)`. Replaces `MacStepRunSplitLayout`. Unit tests cover every row of the table in 2.2. |
| `Lab86MailMac/Work/MacThreadPane.swift` | The inspector content and the mode switch. `MacPagePane` = `PagePaneView` plus the Mac menu ("Larger view", "Open in its own window", "Copy the page address", "Close the page"). `MacDetailsPane` = a header "Details" with a close control, then `WorkDetailsBody`. Also the body of the narrow-window popover. |
| `Lab86MailMac/Work/MacThreadToolbar.swift` | The toolbar items: the plan-line button and `MacPlanPopover` (wraps `PlanListView`, detachable), the Page and Details toggles with the status dot, the menu. |
| `Lab86MailMac/Shell/MacThreadCommands.swift` | The View menu items and key equivalents: "Show Page", "Show Details", "Stop Albatross", "Do the next action". `AlbatrossCommands` includes them. |
| `Lab86MailMac/App/MacPageWindow.swift` (phase 2) | The `Window` scene for the page in its own window. |

Goes away: `Lab86MailMac/Work/MacStepRunLivePane.swift`. Its session follower moves into
`WorkThreadModel` (the Mac source is the Convex live query, the iOS source is the 3-second
poll); its bar and placeholder states are `PagePaneView`; its `MacLiveViewWebView` is the shared
`LiveViewWebView`, which already compiles on the Mac through the shim.

Tour screens to add in `NativeTourMacTests.swift`: `mac-work-thread-run` (open run with the page
pane), `mac-work-thread-form` (S9 and S10), `mac-work-thread-handoff` (S13), `mac-work-thread-narrow`
(D < 960), `mac-settings-personal-details`. `cacheDisplay` does not draw a `WKWebView`, so the run
screen shows the pane chrome with the "no page yet" placeholder, as the step runner tour does.

### 3.3 Modifiers and `#if os(macOS)` branches the Mac asks for in shared code

`WorkThreadModel`:

- Expose `planLine`, `threadState`, `items`, `openRun`, and `pageSession` (the followed
  `WorkBrowserSessionPayload?`) as observed properties. The Mac toolbar and pane read them.
- Take a `RunsSource`: `.poll(seconds:)` on iOS, `.subscribe` (the Convex
  `runsForWorkHistory` and `activeSessionForWork` queries) on the Mac.
- An `events` stream: `pageOpened`, `pageClosed`, `handoff(run)`, `form(question)`, `done(run)`,
  `failed(run)`. The Mac opens the pane and announces from it.

`AssistantComposer`:

- `.onSubmit` sends. No `.keyboardShortcut(.defaultAction)` on the send button. `#if os(macOS)`
  `onKeyPress(.return, modifiers: .shift)` inserts a line.
- A `placeholder` parameter ("Write to Albatross") and a `hidesContextChip` parameter.
- The field uses `focusEffectDisabled()`; the capsule draws the ring (2.8).

`AssistantTranscriptRows`: `.frame(maxWidth: 720)` on the stack, centered, when the host asks
for it (`readingMeasure: CGFloat?`).

`RunBlockView`:

- The page row takes `pageShown: Bool`, `onShowPage`, and `onHidePage`. iOS passes its sheet
  action and `pageShown: false`. The row text on the Mac: "Albatross is on the page ·
  aliveat25.com" with "Show the page" or "Hide the page" (iOS: "Open").
- `.pointerMenu { … }` with the items in 2.7 (the helper exists in
  `PointerAndKeyAffordances.swift`).
- `.stopShortcut()` on "Stop" (exists). The primary button and the second button get a new
  helper `waitingActionShortcut()` = `keyboardShortcut(.return, modifiers: .command)` on the Mac,
  nothing on iOS. `primaryActionShortcut()` (plain Return) leaves the thread blocks, because the
  composer owns Return. The Brief rows keep their behaviour.
- `#if os(macOS)` hover "Copy" on the summary.

`FormQuestionCard`:

- Field layout: `#if os(macOS)` a two-column `Grid` (label column 140 points, control column
  flexible) when the card is ≥ 560 wide; iOS stacks label over control.
- "Save to my details": `#if os(macOS)` `.toggleStyle(.checkbox)`; iOS keeps the switch.
- The submit at the trailing edge; "Not now" (chat forms only) quiet at the leading edge of the
  same row (Mac sheet button order). iOS keeps its own row.
- The submit button: `.keyboardShortcut(.defaultAction)` only while `@FocusState` is inside the
  card; `waitingActionShortcut()` always.
- Choice rows: `.hoverHighlight()` (exists).

`PagePaneView`:

- No fixed height; the inspector gives it. A `trailingAccessory` slot for the Mac menu.
- The bar's done label comes from `next.doneLabel` when the server adds it (iOS open question
  6), else "Continue".

`PersonalDetailsSettingsView` and `PersonalDetailEditorView`: see section 6 for the branches.

`MacChatOverlay`: hide when `environment.navigation.workRoute != nil`.

`MacSheetChrome`: the clamped size (2.2).

`AlbatrossCommands`: include `MacThreadCommands`.

## 4. User stories on the Mac

Copy is exact. Sentence case. No icon before text. Shared lines follow the iOS note's copy
table; Mac-only lines are in the copy table at the end.

**S1. Open from anywhere.** The user clicks an Albatross in the Albatrosses list, a row in
Today, a Brief line, or a notification. The thread opens in the detail column, scrolled to the
newest item. When a run waits, its form or handoff is the last item, 16 points above the
composer. The pane state is remembered for each Work: a thread that had the page open reopens
with the page when a session is still live, else with no pane. A `WorkRoute.intent` of
`.openPage` (a "Ready for you" row with a page handoff) opens the pane at once on a wide window,
or the sheet on a narrow one. A click on a chat card "Work: Register for the course" in the
torn-out chat window opens the thread in the main window and brings that window forward.

**S2. A new Albatross.** The user captured "register for Alive at 25 before Nov 2". The thread
opens with the outcome block:

```
Register for Alive at 25 before Nov 2
Course at aliveat25.com must be finished before the November 2 court appearance.
1  Register for the course · Albatross can handle it          Handle it
2  Attend the court appearance on November 2 · You
```

While the plan is not ready, the block reads "Albatross makes the plan." with a `RevealDot`, and
the composer works. The plan line in the toolbar reads "Albatross makes the plan".

**S3. The plan at a glance.** The toolbar reads "Step 1 of 2 · Your turn ⌄". A click opens a
detachable popover, 360 wide, with `PlanListView`:

```
Plan
✓  Find the course site              Verified on the page · Oct 7
1  Register for the course           Your turn                     Handle it
2  Attend the court appearance on November 2    Next
Albatross keeps the plan here. Say what changed in the conversation, and the plan follows.
```

Each runnable step has "Handle it". A done step shows its proof line. A click on a step row
scrolls the thread to that step's newest run block and closes the popover. Escape closes the
popover. A drag detaches it, so the user can keep the plan beside the conversation.

**S4. Older chats.** The newest chat about this Work is the conversation. The older ones sit in
the details pane under "Older chats" as rows with the date and the first line. A click opens
that chat read only in the torn-out chat window, with the banner "An older chat about this
Albatross. Write in the Albatross to continue." The thread does not merge them.

**S5. Away and back.** The Brief started a run at 7:02. The user opens the thread at 8:30. The
timeline shows, in order: the outcome block, the run block "Started by the Brief · 7:02" with
its summary, the files it made, and the handoff at the bottom. The pane does not open by itself
for a Brief run; the handoff's page row offers "Show the page". The notification deep link lands
on the same place.

**S6. Start.** The user presses "Handle it" in the outcome block, or writes "go ahead and
register me" and presses Return. "Handle it" posts `start` directly and the block draws at once.
The written request goes through the chat; the reply shows the row "Started on the step" and the
run block renders inside that reply:

```
Working on: Register for the course        Started by you · 9:41
9:41  Opened aliveat25.com
9:41  Read your details: name, email, address
9:41  Found 3 classes before November 2
Show all 7 lines
[Stop]
```

The newest three lines show (iOS rule); "Show all 7 lines" reveals the rest. Command-period
stops. The plan line reads "Step 1 of 2 · Albatross works".

**S7. Watch the page.** The run opens a site. On a wide window the page pane opens at the right
with a crossfade. The bar reads "Albatross is on the page" with the session detail under it,
"Opening the class list". "Take over" sits at the trailing edge of the bar. The run block shows
the page row "Albatross is on the page · aliveat25.com" with "Hide the page" while the pane is
open. If the details pane was open, the page takes its place; the Details toggle turns off.

**S8. Talk while it works.** The user writes "use the Monday class" and presses Return. The
message goes to the run as a steer note. The reply shows the row "Sent your note to the run" and
one line: "Noted. I will use the Monday class." The run block adds "9:42  Read your note: use the
Monday class". The composer stays ready. No second block appears.

**S9. A choice that is mine.** The run found three classes. It reads the calendar and the run
block ends with one form:

```
Albatross needs one answer
I found three classes before November 2. I did not pick one. Your calendar is free on two of them.

Which class?
( ) Monday, October 19        4:00–8:00 PM · Zoom · $70        Free on your calendar
( ) Wednesday, October 21     4:00–8:00 PM · Zoom · $70        Conflicts with Team sync
( ) Saturday, October 24      9:00 AM–1:00 PM · Zoom · $70     Free on your calendar
( ) Other                     [                           ]
```

The first option is the one that matches "Monday or Wednesday" from the conversation. Nothing
is preselected: a choice the user owns is not made for them. The conflict note is red; the other
notes are secondary text. The plan line reads "Step 1 of 2 · Needs an answer".

**S10. Missing details in the same form.** Under the choice, the same form continues:

```
Your details for the form
Name            Sam Rivera                              From your account
Email           sam.rivera@example.com                  From your account
Home address    12 Harbor Lane, Apt 4, Portland, ME     From your details
Phone           [(555) 010-0100              ]
                [x] Save to my details
                Albatross uses saved details in later forms.
                                                              [Continue  ⌘↩]
```

Filled fields are read-only rows with an "Edit" text button on hover. The empty phone field
has focus. Return submits. One submit answers both parts. The button is disabled until the phone
is valid. A runner question has no skip (iOS open question 5).

**S11. Answer in my own words.** The user ignores the form and writes "Monday works, my phone is
555 010 0100". Return sends. The reply shows the row "Saved to your details", the receipt card
"Saved to your details: Phone" with "Undo" at the trailing edge, and the line "Thanks. I sent your
answer to the run." The form collapses to "Answered in the chat." with the answer line "Monday,
October 19 · Phone (555) 010-0100". Edit > Undo reads "Undo Saved to your details". The run
continues as a continuation block.

**S12. Sign in.** The site asks for a sign-in. The run block reads:

```
Your turn
Sign in to aliveat25.com in the page, then press Continue.
[Sign in]   [I signed in]      Dismiss
```

On a wide window the pane opens; "Sign in" brings focus to it. The bar reads "Sign in on the
page. Albatross does not see your password." with "I signed in" at the trailing edge. The user
signs in and presses "I signed in" in the bar or in the block, or writes "done". The bar then
reads "Albatross checks the page…" until the new run takes the page. The next time the site
still knows the user.

**S13. The final page.** The run filled the form for Monday, October 19. It stops:

```
Your turn · Started by you · 9:52
I filled in the form for Monday, October 19 with your name, email, phone, and address.
Everything is filled in. Check it and pay the $70.
Registration form · Page
▸ What I did
[Check and pay]   [I paid]      Dismiss
```

The pane shows the filled form. The bar reads "Everything is filled in. Check it and pay the
$70." with "I paid" at the trailing edge. "Check and pay" brings focus to the pane (or opens
the sheet). After payment the user presses "I paid" (Command-Return). The bar reads "Albatross
checks the page…". Then the block becomes the done block: "Done · Verified on the page", the proof
"Registration confirmed for Monday, October 19. Confirmation number ends in 0100.", and the
artifact row "Confirmation page · Page".

**S14. Drafts and documents.** A draft is an artifact row in the run block: "Note to the court
clerk · Draft" with "Read and send", which opens the composer sheet with that draft id. A
document is a row: "Registration confirmation · Document" with "Open the document", which opens
the document in Files. Both also appear in the details pane under Files.

**S15. Done.** The proof line appears in the block. The plan line changes to "Step 2 of 2".
Albatross writes one line: "Next: attend the court appearance on November 2. I will watch for
the Zoom invite." No button appears for a step only the user can do.

**S16. Failed or stopped.** Failed: "This run did not finish." with the red line "aliveat25.com
did not load after three tries." and "Try again". Stopped by a limit: "Albatross stopped at its
time limit." with "Continue". Stopped by the user: one line "Stopped by you." with "Continue".
Each keeps "What I did" collapsed. Command-Return is "Continue" on a stopped block and nothing
on a failed block.

**S17. Ask.** The user writes "when is the court date?". Albatross answers "November 2 at 9:00
AM, at the Monroe County Hall of Justice. It is on your calendar." with one event card. No run
starts.

**S18. Change the plan.** The user writes "I already registered, skip that". The reply shows the
rows "Recorded progress" and "Replanned the Work", then "Done. Step 1 is marked done as reported.
Next: the court appearance on November 2." The plan line reads "Step 2 of 2". The outcome block's
step row 1 shows a check with "Marked done".

**S19. Details.** Control-Command-I or the toggle opens the details pane:

```
Details                                                      ×
Outcome
  Register for Alive at 25 before Nov 2 · guided · by Nov 2
Commitments
  (the outcome contract)
Proof
  Oct 19  Verified on the page · Confirmation number ends in 0100
Files
  Note to the court clerk          Draft       Read and send
  Registration confirmation        Document    Open the document
  Reminder: court appearance       Event       Undo
Plan document
  (the plan document)
Context
  Assumptions · Sources
Older chats
  Oct 5 · Which class should I pick?
```

The section order is the iOS note's (2.6). "Split…", "Put it down", "Set horizon…", and "Mark
done" are in the toolbar menu.

**S20. It knows me.** A form asks for the name, email, phone, and address. The run types them
and writes "Read your details: name, email, address" then "Typed your name, email, and address."
in the log. No question appears for them.

**S21. Settings.** Settings, Account, "Personal details" (under Connections) opens the page in
section 6. Each row shows the value and where it came from. The intro reads "Albatross types
these into forms when a step needs them." The footer reads "Albatross never saves passwords, card
numbers, or ID numbers here. Delete any detail at any time."

**S22. Found in my mail.** The phone field in a form shows "(555) 010-0199" with the caption
"From your email signature" under it. The field is editable. "Save to my details" is on. On
submit, the receipt reads "Saved to your details: Phone".

**S23. My legal name.** The account says "Sam rivera". In Personal details the user opens Name.
The editor shows First "Sam", Last "rivera", and the line "Your account says Sam rivera. Forms
use what you save here." The user fixes the last name and saves. The row reads "Sam Rivera · You
saved this on Oct 7". "Use the account name" removes the saved copy.

**S24. Something it must not keep.** The user writes a Social Security number in the composer.
Albatross answers: "I do not keep that number. Albatross cannot store ID numbers yet. Type it on
the page yourself when the form needs it." No receipt appears. In Settings the editor refuses the
same value with "Albatross does not keep this number here." under the field.

## 5. State matrices

### 5.1 The page pane (page mode)

| State | Dot | Bar line | Controls | Content |
|---|---|---|---|---|
| Opening (session row not yet read) | accent-2 | "Opening the shared browser…" | none | spinner on the subtle surface |
| Albatross has the page | accent-2 | the session detail, else "Albatross has the page." | "Take over", "Larger view ⌄" | live view, interactive |
| Your turn (handoff `sign_in` or `finish_on_page`) | accent | the handoff detail ("Sign in on the page. Albatross does not see your password.") | the done label ("I signed in", "I paid"), else "Continue"; "Check the page"; "Larger view ⌄" | live view |
| Your turn after Take over | accent | "You have the page. Press Continue when Albatross should go on." | "Continue", "Larger view ⌄" | live view |
| Checking | accent-2 | "Albatross checks the page…" | all disabled | live view |
| User owned (from the plan popover's "Open the site") | accent | "Your turn on the page. Albatross follows along." | "Check the page" | live view |
| Checked, satisfied | green | "Verified. The step is checked off." | "Close the page" | live view |
| Checked, not yet | accent | "Not yet: {reason}" | "Continue", "Check the page" | live view |
| Closed (no session, run ended) | none | "The page is closed." | "Continue" when a handoff waits, "Close the pane" | the placeholder "Albatross opens a new page when a step needs one." |
| No page yet (run open, no session) | none | "Albatross has not opened a page yet." | none | placeholder "The live view shows here when it does." |
| Error (session failed, live view did not load) | red | "The page could not load. Open the site in Safari." | "Open in Safari", "Close the pane" | placeholder |

Rules:

- The pane never starts or ends a session. The run owns the session (PR #319).
- "Take over" sends `cancel`. The done label and "Continue" send `resume`. "Check the page" calls
  the verify route of the session. "Close the page" ends a user-owned session.
- The small menu under "Larger view ⌄": "Larger view" (the sheet), "Open in its own window"
  (phase 2), "Copy the page address", divider, "Close the page".
- The pane keeps its session while the user switches to details and back. The session follower
  lives in `WorkThreadModel`, not in the pane, so a mode switch does not drop the subscription.

### 5.2 The details pane (details mode)

| Section | Empty state | Rows |
|---|---|---|
| Outcome | always present | title, summary, the shape word (opens the picker), the horizon line (opens the horizon popover) |
| Shape body | hidden for guided shapes | `ListBody`, `PracticeBody`, or `ProjectBody` |
| Commitments | hidden when none | `OutcomeContractView` |
| Proof | "No proof yet." | `ProofTimelineView` |
| Files | "No files yet." | one row for each artifact of every run, newest first: title, kind, one trailing verb; "Undo" where an operation id exists |
| Plan document | "Albatross makes the plan." with a `RevealDot`, or "No plan yet." | `BriefDocumentView` or the artifact web view |
| Context | hidden when none | assumptions and sources |
| Older chats | hidden when none | date and first line; click opens read only |

The pane header reads "Details" with a close control at the trailing edge. The pane scrolls as
one column. Sections are disclosure groups, all open by default; the open state persists per
user, not per Work. The pane keeps the page width band, so the plan document reads at a full
measure.

### 5.3 The run block on the Mac

The shared `RunBlockView` draws the states in the iOS note's table 5.1. The Mac adds:

| Part | iOS | Mac |
|---|---|---|
| Log | newest three lines, "Show all N lines" | same, plus a tooltip with the full time on hover |
| Summary | plain text | plain text, "Copy" at the trailing edge on hover, no reserved space |
| Page row | "Albatross is on the page · {host}" with "Open" (the sheet) | wide: "Show the page" opens the pane, "Hide the page" closes it; narrow: "Open" opens the clamped sheet. The dot matches the pane dot. |
| Stop | button | button with Command-period, and in the View menu |
| Primary and second button | buttons | buttons; the one that waits carries Command-Return, and its help shows "⌘↩" |
| Context menu | none | primary action, "Continue", "Copy the summary", "Copy the log", divider, "Dismiss" |
| Continued run | "Continued · 9:41" rule | the same, with the time at the trailing edge |
| Inline page preview | none | none. A live thumbnail in a scroll view costs a second web view and the tour cannot draw it. The page row is the preview. |

## 6. Mac Settings: Personal details

### 6.1 Where it lives

`SettingsView.swift`, the Account section, under "Connections" (iOS note, 3.3):

```
Account
  Albatross                     Signed in
  Plan …
  Mailboxes                                                >
  Connections                                              >
  Personal details              Sam Rivera, 3 more         >
```

The row's value is the name and a count of the other saved details. The Trust footer adds
"Personal details are what Albatross types into forms."

### 6.2 The page

A `Form` with `.formStyle(.grouped)` (inherited from the Settings sheet). The intro line, one
section for the fixed keys, one for the other details, the footer.

```
Personal details
Albatross types these into forms when a step needs them.

  Name              Sam Rivera                                  [Edit]
                    From your account
  Email             sam.rivera@example.com                      [Edit]
                    From your account
  Phone             (555) 010-0100                              [Edit]
                    You told Albatross on Oct 7
  Home address      12 Harbor Lane, Apt 4, Portland, ME 04101   [Edit]
                    You saved this on Oct 7
  Emergency contact Not set                                     [Add]
Other details
  Employer          Harbor Clinic                               [Edit]
  Add a detail                                                  [Add]
Albatross never saves passwords, card numbers, or ID numbers here. Delete any detail at any
time.
```

- Each row is `LabeledContent(label) { value + caption }` with one bordered button at the
  trailing edge inside `#if os(macOS)`, as `SavedSignInsView` does. iOS keeps a `NavigationLink`
  row with the chevron.
- The button says "Edit" when a value exists and "Add" when none. No ellipsis: a push follows,
  not a dialog.
- The source captions are the iOS note's: "From your account", "You saved this on Oct 7", "You
  told Albatross on Oct 7", "From a form on Oct 7". An unsaved account default shows "From your
  account" and the editor has no delete.

### 6.3 The editor

`PersonalDetailEditorView` pushes inside the Settings `NavigationStack`. No second sheet (HIG:
one sheet at a time; the Settings sheet is already up).

Name:

```
Name
  First             [Sam                ]
  Middle            [                   ]   Optional
  Last              [rivera             ]
Your account says Sam rivera. Forms use what you save here.
  Use the account name
                                                       Cancel   [Save]
```

- A grouped Mac `Form` shows a `TextField` title as the row label (mac-offscreen-render-probe).
  So the row label is the field title, and the example text goes in `prompt:`:
  `TextField("First", text: $first, prompt: Text("Sam"))`. Never put the example in the title.
- Return in the last field is Save. Escape is Cancel (the push pops). Save is the window default
  inside the editor.
- "Delete" for a saved detail: `#if os(macOS)` a bordered "Delete…" button at the leading edge
  of the button row, with a confirmation dialog "Delete your phone?" / "Forms ask you for it
  again." / "Delete". iOS keeps its destructive row at the bottom. The Name editor has "Use the
  account name" in place of delete.
- Address: Line 1, Line 2 (Optional), City, State or region, Postal code, Country (a `Picker`
  of `Locale.Region` names, default from the current locale, ISO code sent). Phone: one field,
  prompt "(555) 010-0100", the contract's loose regex, E.164 on save when it parses; the help
  line "Forms get this number. Albatross asks before it saves a new one." Email: one field,
  prompt `sam.rivera@example.com`; render the literal with `Text(verbatim:)` so it does not
  autolink. Emergency contact: Name, Phone, Relationship (Optional). A detail: Label, Value.
- A refused value (a card number, an ID number) returns the server line in red under the field:
  "Albatross does not keep this number here." The field keeps its text so the user can fix it.
- Save writes with `PUT /api/personal-details`; the row updates when the server confirms, as the
  Saved sign-ins row does.

## 7. Accessibility, dark mode, vibrancy

VoiceOver:

- Each run block is a container with a header element, as the iOS note says: "Albatross works
  on Register for the course. Newest: Opened the class list. Started by you." The rotor finds
  the headers.
- The plan line button has the label "Plan: step 1 of 2, your turn" and the hint "Opens the
  steps".
- The Page toggle has the value "Albatross is on the page", "Your turn on the page", or "No
  page". The Details toggle has the value "Open" or "Closed".
- The pane is one container labelled "Shared browser". The live view is the remote page's own
  accessibility tree.
- `PlatformAccessibility.announce` fires on a state change only, with the iOS note's lines:
  "Albatross started on Register for the course.", "Your turn: Sign in to aliveat25.com.",
  "Albatross asks: Which class?", "Step done: Register for the course.", "This run did not
  finish." Log lines do not announce.
- A form option row is a button with the selected trait; the calendar note is part of its
  label: "Monday, October 19, 4 to 8 PM, Zoom, 70 dollars. Free on your calendar."
- The receipt's "Undo" is a button with the label "Undo. Saved to your details: Phone".

Full Keyboard Access:

- Every row, toggle, and button is focusable. The plan popover is a focusable list with the
  "Handle it" buttons in the tab order.
- The draggable divider has a keyboard alternative: the View menu's "Show Page" and "Show
  Details" open the pane at its default width, and the pane remembers a dragged width.

Dark mode:

- The surfaces follow the native depth ladder in `Surface.swift`: paper for the conversation,
  elevated for the composer and form cards, subtle for the log well and the pane placeholder.
- The live view sits in a subtle well with a 1-point hairline, so a white page does not read as
  a hole in a dark window.
- The status dots use accent-2, accent, green, and red; each dot has a text line beside it, so
  colour never carries the meaning alone.

Vibrancy limits:

- The sidebar keeps its system vibrancy. The conversation column and both pane modes are opaque
  paper. A translucent material behind a `WKWebView` flickers on scroll, and `cacheDisplay`
  drops vibrancy in the tour, so the pane uses none.
- The composer's glass effect falls back to the elevated colour under Reduce Transparency, as
  the grain overlay already does.
- Reduce Motion: the pane crossfades; no slide, no spring. The `RevealDot` stops its pulse.

## 8. Wireframes

Window at 1440 by 900, sidebar 260, conversation 540, pane 616.

### 8.1 A running run with the page pane (S6, S7, S8)

```
┌──────────────────────┬──────────────────────────────────────────────┬─────────────────────────────────┐
│ Albatross        [+] │ Register for the Alive at 25 course          │                   [◎] [▣] [⋯]   │
│                      │ Step 1 of 2 · Albatross works ⌄              │                                 │
├──────────────────────┼──────────────────────────────────────────────┼─────────────────────────────────┤
│ Search mail      ⌘F  │ Register for Alive at 25 before Nov 2        │ ● Albatross is on the page      │
│                      │ 1 Register for the course · Albatross works  │   Reading the class list        │
│ Today                │ 2 Attend the court appearance · You          │          [Take over]  Larger ⌄  │
│ Albatrosses  4 need  │                                              ├─────────────────────────────────┤
│ Chat                 │                               ┌────────────┐ │ ┌─────────────────────────────┐ │
│ Mail                 │                               │ go ahead   │ │ │ aliveat25.com               │ │
│ Calendar             │                               │ and        │ │ │                             │ │
│                      │                               │ register me│ │ │  ALIVE AT 25 · Classes      │ │
│ Your areas           │                               └────────────┘ │ │  Mon Oct 19  4:00–8:00 PM   │ │
│ ● Personal           │ Started on the step                          │ │  Wed Oct 21  4:00–8:00 PM   │ │
│ ● Harbor Clinic      │ ┃ ◉ Working on: Register for the course      │ │  Sat Oct 24  9:00–1:00 PM   │ │
│                      │ ┃   Started by you · 9:41                    │ │                             │ │
│                      │ ┃   9:41  Opened aliveat25.com               │ │  [Reserve a spot]           │ │
│                      │ ┃   9:41  Read your note: use the Monday     │ │                             │ │
│                      │ ┃         class                              │ │                             │ │
│                      │ ┃   9:42  Typed your name, email, and        │ │                             │ │
│                      │ ┃         address                            │ │                             │ │
│                      │ ┃   Show all 7 lines                         │ │                             │ │
│                      │ ┃   ● Albatross is on the page · aliveat25…  │ │                             │ │
│                      │ ┃                            Hide the page   │ │                             │ │
│                      │ ┃                                     Stop   │ │                             │ │
│                      │                                              │ │                             │ │
│                      │                               ┌────────────┐ │ │                             │ │
│                      │                               │ use the    │ │ │                             │ │
│                      │                               │ Monday     │ │ │                             │ │
│                      │                               │ class      │ │ │                             │ │
│                      │                               └────────────┘ │ │                             │ │
│                      │ Sent your note to the run                    │ │                             │ │
│                      │ Noted. I will use the Monday class.          │ └─────────────────────────────┘ │
│                      │                                              │                                 │
│                      │ ┌──────────────────────────────────────────┐ │                                 │
│ Settings             │ │ (clip)  Write to Albatross     Ask  (up) │ │                                 │
└──────────────────────┴─┴──────────────────────────────────────────┴─┴─────────────────────────────────┘
```

`[◎]` is the Page toggle (globe), `[▣]` the Details toggle (sidebar.trailing), `[⋯]` the menu.
"(clip)" is the attach control, "(up)" the send control, "Ask" the route chip.

### 8.2 The S9 and S10 form (pane open, conversation column 540)

```
│ ┃ Albatross needs one answer                                        │
│ ┃ I found three classes before November 2. I did not pick one.      │
│ ┃ Your calendar is free on two of them.                             │
│ ┃ ┌─────────────────────────────────────────────────────────────┐   │
│ ┃ │ Which class?                                                │   │
│ ┃ │ ( ) Monday, October 19     4:00–8:00 PM · Zoom · $70        │   │
│ ┃ │                            Free on your calendar            │   │
│ ┃ │ ( ) Wednesday, October 21  4:00–8:00 PM · Zoom · $70        │   │
│ ┃ │                            Conflicts with Team sync         │   │
│ ┃ │ ( ) Saturday, October 24   9:00 AM–1:00 PM · Zoom · $70     │   │
│ ┃ │                            Free on your calendar            │   │
│ ┃ │ ( ) Other                  [                             ]  │   │
│ ┃ │                                                             │   │
│ ┃ │ Your details for the form                                   │   │
│ ┃ │ Name          Sam Rivera                  From your account │   │
│ ┃ │ Email         sam.rivera@example.com      From your account │   │
│ ┃ │ Home address  12 Harbor Lane, Apt 4,      From your details │   │
│ ┃ │               Portland, ME 04101                            │   │
│ ┃ │ Phone         [(555) 010-0100          ]                    │   │
│ ┃ │               [x] Save to my details                        │   │
│ ┃ │               Albatross uses saved details in later forms.  │   │
│ ┃ │                                                  [Continue] │   │
│ ┃ └─────────────────────────────────────────────────────────────┘   │
│ ┃ Dismiss                                                           │
```

At a card width of 560 or more the label and the control sit in two grid columns; the
calendar note moves to the trailing edge of the option row.

### 8.3 The S13 handoff with the page pane

```
┌──────────────────────┬──────────────────────────────────────────────┬─────────────────────────────────┐
│ Albatross        [+] │ Register for the Alive at 25 course          │                   [◎] [▣] [⋯]   │
│                      │ Step 1 of 2 · Your turn ⌄                    │                                 │
├──────────────────────┼──────────────────────────────────────────────┼─────────────────────────────────┤
│ …                    │ ┃ Your turn · Started by you · 9:52          │ ● Everything is filled in.      │
│                      │ ┃ I filled in the form for Monday, October   │   Check it and pay the $70.     │
│                      │ ┃ 19 with your name, email, phone, and       │  [Check the page]  [I paid]  ⌄  │
│                      │ ┃ address.                                   ├─────────────────────────────────┤
│                      │ ┃ Everything is filled in. Check it and pay  │ ┌─────────────────────────────┐ │
│                      │ ┃ the $70.                                   │ │ Reserve a Spot              │ │
│                      │ ┃ Registration form · Page      Hide the page│ │ First name   Sam            │ │
│                      │ ┃ ▸ What I did                               │ │ Last name    Rivera         │ │
│                      │ ┃ [Check and pay]  [I paid]                  │ │ Street       12 Harbor Lane │ │
│                      │ ┃ Dismiss                                    │ │ City         Portland       │ │
│                      │                                              │ │ State        ME             │ │
│                      │                                              │ │ Zip          04101          │ │
│                      │                                              │ │ Phone        (555) 010-0100 │ │
│                      │                                              │ │ Email  sam.rivera@example…  │ │
│                      │                                              │ │                             │ │
│                      │                                              │ │ Card number  [            ] │ │
│                      │                                              │ │ [Pay $70]                   │ │
│                      │ ┌──────────────────────────────────────────┐ │ └─────────────────────────────┘ │
│ Settings             │ │ (clip)  Write to Albatross     Ask  (up) │ │                                 │
└──────────────────────┴─┴──────────────────────────────────────────┴─┴─────────────────────────────────┘
```

After "I paid": the bar reads "Albatross checks the page…", then the block reads "Done ·
Verified on the page" and the plan line reads "Step 2 of 2".

### 8.4 The narrow window (760 by 700, sidebar collapsed, D = 760 < 960)

```
┌────────────────────────────────────────────────────────────────┐
│ ≡  Register for the Alive at 25 course          [◎] [▣] [⋯]    │
│    Step 1 of 2 · Your turn ⌄                                   │
├────────────────────────────────────────────────────────────────┤
│ ┃ Your turn · Started by you · 9:41                            │
│ ┃ Sign in to aliveat25.com in the page, then press Continue.   │
│ ┃ ● Albatross is on the page · aliveat25.com            Open   │
│ ┃ [Sign in]  [I signed in]                                     │
│ ┃ Dismiss                                                      │
│                                                                │
│                                                                │
│ ┌────────────────────────────────────────────────────────────┐ │
│ │ (clip)  Write to Albatross                       Ask  (up) │ │
└─┴────────────────────────────────────────────────────────────┴─┘
```

"Open" and "Sign in" open the sheet clamped to the window (712 by 652 here). The Page toggle
shows the accent dot while the sheet is closed. The Details toggle opens the detachable popover.

### 8.5 Personal details in Settings (the Settings sheet, 620 wide)

```
┌───────────────────────────────────────────────────────────────┐
│ ‹ Settings                          Personal details     Done │
├───────────────────────────────────────────────────────────────┤
│ Albatross types these into forms when a step needs them.      │
│ ┌───────────────────────────────────────────────────────────┐ │
│ │ Name              Sam Rivera                       [Edit] │ │
│ │                   From your account                       │ │
│ │ Email             sam.rivera@example.com           [Edit] │ │
│ │                   From your account                       │ │
│ │ Phone             (555) 010-0100                   [Edit] │ │
│ │                   You told Albatross on Oct 7             │ │
│ │ Home address      12 Harbor Lane, Apt 4,           [Edit] │ │
│ │                   Portland, ME 04101                      │ │
│ │                   You saved this on Oct 7                 │ │
│ │ Emergency contact Not set                          [Add]  │ │
│ └───────────────────────────────────────────────────────────┘ │
│ Other details                                                 │
│ ┌───────────────────────────────────────────────────────────┐ │
│ │ Employer          Harbor Clinic                    [Edit] │ │
│ │ Add a detail                                       [Add]  │ │
│ └───────────────────────────────────────────────────────────┘ │
│ Albatross never saves passwords, card numbers, or ID numbers  │
│ here. Delete any detail at any time.                          │
└───────────────────────────────────────────────────────────────┘
```

The Phone editor (pushed):

```
┌───────────────────────────────────────────────────────────────┐
│ ‹ Personal details                  Phone                     │
├───────────────────────────────────────────────────────────────┤
│ ┌───────────────────────────────────────────────────────────┐ │
│ │ Phone             [(555) 010-0100                       ] │ │
│ └───────────────────────────────────────────────────────────┘ │
│ Forms get this number. Albatross asks before it saves a new   │
│ one.                                                          │
│ You told Albatross on Oct 7.                                  │
│                                                               │
│ [Delete…]                                   Cancel    [Save]  │
└───────────────────────────────────────────────────────────────┘
```

## 9. Open questions for the lead designer

1. **One trailing pane, or page and details at once?** Recommendation: one pane. The page takes
   it when a run opens a site; the user can switch to details and back; the session stays.
   Four columns need 1500 points and most Mac windows are not that wide. If both are wanted
   later, let both show only at D ≥ 1360 behind a View menu item.
2. **`.inspector` or a custom split?** Recommendation: `.inspector` with one width band for both
   modes (460–760). The iPad takes `.inspector` with the same `PagePaneView` (iOS note, 7.2 and
   open question 9), the framework restores the width, and `InspectorCommands` gives the View
   menu item. The cost: the details pane is as wide as the page pane; the plan document gains
   from it. Fallback: a custom split that extends `MacStepRunSplitLayout`, if a CI build shows
   the inspector ignores the width or cannot open from a run event.
3. **Return or Command-Return for the one action that waits?** Recommendation: Command-Return.
   The composer owns Return. A default button that fires when the user presses Return to send
   an empty composer is a bug waiting to happen. Return still submits a form from a form field.
4. **Hide the floating chat bubble on the thread?** Recommendation: yes. Two composers on one
   screen was problem 6 in the brief. Command-K focuses the thread composer while a thread is
   on screen.
5. **The page in its own window?** Recommendation: phase 2, after the pane ships. The `Window`
   scene pattern exists (`MacChatWindowScene`), so the cost is low, but the pane must be right
   first.
6. **A click on the live page while Albatross has it.** Recommendation: a three-second line in
   the bar, no block. Manus and Claude in Chrome let the user act at any time. A blocking
   overlay would hide the page the user came to read. Measure in dogfood; if users fight the
   run, add a one-click "Take over" overlay on the first click.
7. **Where "Personal details" sits in Settings.** The iOS note decided: Account, under
   Connections. The Mac agrees. The two footers (Account and Trust) point at each other.
8. **Auto-open of the page pane.** Recommendation: open the pane by itself only for a run the
   user started from this window (S6, S12, S13), or when the route carries `.openPage` (S1). A
   Brief or conductor run never opens a pane while the user reads something else (S5); its page
   row offers "Show the page".
9. **Should the sidebar collapse by itself when the pane needs room?** Recommendation: yes,
   because the page pane is the point of the window at that moment, and the HIG names Mail as
   the precedent. The sidebar returns when the pane closes. Watch for complaints in dogfood.
10. **The done label in the pane bar.** The bar wants "I paid" and "I signed in", not "Continue".
    This depends on the server's `next.doneLabel` (iOS open question 6). Recommendation: add it
    in PR 1; until then the bar shows "Continue" and the block shows `next.label` plus
    "Continue".
11. **Runs on the Mac: subscribe or poll?** Recommendation: subscribe. The Mac already follows
    `activeSessionForWork` live, and the thread brief names `runsForWorkHistory` for web and
    Mac. `WorkThreadModel` takes the source as a parameter, so iOS can poll.

## Copy table (Mac additions)

Shared lines are in the iOS note's copy table. These are Mac only.

| Where | Line |
|---|---|
| Page toggle help | "Show the page (Control-Command-P)", "Hide the page", "Albatross is on the page", "Your turn on the page", "No page", "The page is in its own window" |
| Details toggle help | "Show the details (Control-Command-I)", "Hide the details" |
| Pane bar, Mac only | "Opening the shared browser…", "Albatross has not opened a page yet.", "The live view shows here when it does.", "The page is closed.", "Albatross opens a new page when a step needs one.", "You have the page. Press Continue when Albatross should go on.", "Verified. The step is checked off.", "Not yet: {reason}" |
| Pane controls | "Take over", "Continue", "Check the page", "Larger view", "Open in its own window", "Copy the page address", "Close the page", "Close the pane", "Open in Safari" |
| Pane hint | "Albatross still has the page. Press Take over to act yourself." |
| Page row, Mac | "Show the page", "Hide the page" |
| Block context menu | "Copy the summary", "Copy the log", "Dismiss" |
| Block hover | "Copy" |
| View menu | "Show Page", "Hide Page", "Show Details", "Hide Details", "Stop Albatross", "Do the next action" |
| Plan popover | the `PlanListView` lines; "Open the site" in a step's context menu |
| Details pane header | "Details" |
| Settings row value | "Sam Rivera, 3 more" |
| Settings row buttons | "Edit", "Add" |
| Editor buttons | "Delete…", "Cancel", "Save", "Use the account name" |
| Delete dialog | "Delete your phone?", "Forms ask you for it again.", "Delete" |
| Shortcut reference | "⌘↩ Do the action that waits", "⌘. Stop Albatross", "⌃⌘P Show or hide the page", "⌃⌘I Show or hide the details" |
