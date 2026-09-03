# Refinement round 2026-09-03: macOS design note

Status: planning. Owner: Claude (native Apple platform). Date: 2026-09-03.

This note is the design input for the macOS implementation subagent. It covers the five
waves in `docs/refinement-round-2026-09-03.md`. It is not a verification and it holds no
product code.

Ground truth about the Mac target today (`docs/mobile/macos-target.md` and the code):

- Three-pane shell: `MacSourceList` sidebar, then the selected surface in a `NavigationStack`.
  Mail already splits into list + reader (`MacMailSplitView`). Today, Work, and Calendar are
  single columns.
- Chat is a corner panel (360x480) or a torn-out window. ⌘K toggles the panel. There is no
  ⌘K bar, no ⌘R, and no menu-bar extra.
- `ShellStatusOverlay` shows pending sends and undo only. There is no sync state in it.
- `WorkDetailView` renders one layout for every Work. There is no shape concept on native.
- The main `WindowGroup` has no `defaultSize`. Sheets are functional, not Mac-refined.

Research tools: Mobbin (web platform; Mobbin has no macOS category) and Browserbase page
reads. Mobbin did not ask for authorization. Reference URLs sit inline.

Voice rules for every string below: Simplified Technical English, plain verbs, no icon before
text, no stars or sparkles, no ALL-CAPS labels, never the word "AI".

---

## Wave A. Today cleanup, Later shelf, horizon control, wake nudge

### Findings

1. Things 3 (Mac): Upcoming is "your future agenda" by date; Someday holds undated items out
   of Today; "This Evening" is a quiet section at the foot of Today, "still present, but
   unobtrusive". Quick Entry captures from any app with one shortcut and autofill.
   (https://culturedcode.com/things/support/articles/4001304/ and /2249437/)
2. Featurebase snooze palette: one field that accepts typed text like "in 3 days" or "next
   friday", preset rows under it, and key hints in the footer.
   [Mobbin screen](https://mobbin.com/screens/932552b9-2762-4737-906e-4fca48049a2a)
3. Workable snooze: duration chips (1 month, 2 months, 3 months, Custom) or a specific date,
   plus a note field. Two ways to say the same thing, one control.
   [Mobbin screen](https://mobbin.com/screens/32e629a6-5300-49a5-b02f-adbabff3f70b)
4. Craft Tasks, Upcoming: items grouped under "This Week" with the due date on the right, no
   card chrome. [Mobbin screen](https://mobbin.com/screens/9f0a6cd4-e7c8-4b1a-b9cf-fe3396d61637)
5. Amie, Creating todos: one field ("New todo @list @2pm") with a single key hint, and the
   list groups items under "No date" and "Later".
   [Mobbin flow](https://mobbin.com/flows/6c17416d-c6c5-445a-9c89-6f5301e5a860)
6. Linear snooze takes typed dates ("Jan 3 10am", "next quarter", "for 2 weeks"), and
   Fantastical shows a live preview while you type. (https://linear.app/docs/inbox,
   https://flexibits.com/fantastical/help/adding-events-and-tasks)

### Chosen expression

Today (Mac column, 840pt max):

- Remove "Do this next" card stack, "The plan slipped", "Needs you", and "In motion" from
  Today. Today keeps: masthead, deck line, "Your day" ribbon, "Mail that matters" (max 4
  rows), and one "Next move" line under the ribbon when a move is scheduled for today.
- "Next move" is one sentence in the body face with the step title in the display face:
  "Next move at 14:00: Send the passport form." Click opens the Work. No card, no border.
- Remove `LapsePrompt` and `MissedMoveRecoveryView` from Today and from the calendar top.

Later shelf (Work page, Mac):

- The shelf sits after the open groups and before the Areas footer. Section rule label:
  "Later". Note text: "Kept, not moved."
- The shelf is a horizontal ruler, not a list. Each dormant Work is a card (width 200,
  `surfaceCard`) placed in wake order along a hairline. The ruler is ordinal, not linear:
  cards get equal spacing, and the hairline between two cards carries the elapsed time in the
  caption voice ("6 weeks", "3 months"). Cards with no date sit at the far end after a longer
  gap under the label "Someday".
- Card content: title (2 lines max), horizon line ("Back on Nov 1"), and the user's own words
  in the italic display voice ("after the wedding") when a label exists.
- Hover: the card raises one elevation step (150 ms). Two text buttons appear on the card
  foot: "Wake now" and "Change". No icons.
- Scroll: horizontal trackpad scroll. Mouse wheel scrolls the shelf when the pointer is over
  it. ← and → move focus between cards when a card has focus.
- Narrow window: when the content column is under 640pt, the shelf becomes a vertical list in
  the same order with the elapsed-time captions between rows.
- States: no dormant Work, the shelf is not rendered at all (no empty state; the Work page
  must not get more chrome). Loading and error reuse the page states.

Horizon control (Work detail, Mac):

- Under the title, one text button in the caption voice shows the current horizon
  ("Now", "Back on Nov 1", "Someday"). Click opens a popover (width 320).
- Popover: segmented control "Now / Later / Someday". "Later" shows one text field with
  placeholder "Not before, for example next month" and a live parse line under it in the
  secondary color ("Sunday, Nov 1"). The parse comes from `parseHorizonHint`; when the parse
  fails the line reads "Type a date or a phrase like in two weeks." A second optional field
  "In your words" stores `label`.
- Keys: ⇧⌘H opens the popover. Return commits. Esc cancels. Menu item: Albatross > Horizon…
- Commit motion: the detail header's horizon text crossfades (150 ms). When the kind becomes
  "later" or "someday", the Work row on the Work page slides out of its group and into the
  shelf (280 ms, `.snappy`).

Wake nudge (Mac):

- In-app: a bar slides in from the trailing edge of the detail pane, under the toolbar
  (320 ms spring in, 200 ms ease out). Content: "Passport renewal is back. Ready when you
  are." and one text button "Open". Auto-dismiss after 8 s; hover pauses the timer.
- App not active: a system notification with the same copy and an "Open" action; tapping
  it opens the Work detail through the existing notification-action path.
- Only one nudge shows at a time. A second wake waits in a queue.

"Still carrying this?" review moves to the Work page. On Mac it is a hover row under a stale
item: two text buttons, "Still on it" and "Let it go". The row also opens from the item's
context menu so the keyboard has a path.

Window sizing: no change to the shell. Today keeps the 840pt column.

---

## Wave B. Calendar sync kicks

### Findings

1. Mimestream (Mac): "Synchronize Accounts" is a menu item on ⇧⌘N; the state is text, not
   a toolbar spinner. (https://mimestream.com/help/user-guide/keyboard-shortcuts)
2. Toggl Track calendar settings: connection state and toggles live in a popover, with a
   toast on success ("Google calendar auto-track enabled").
   [Mobbin screen](https://mobbin.com/screens/4a1cff41-129e-4d82-a4ce-daa80bd0219b)
3. Basecamp calendar: subscription state is a sentence ("Subscribe to my events in all
   projects"), not a status badge.
   [Mobbin screen](https://mobbin.com/screens/ec56e60a-e3f1-4511-ae2f-4aa02ba7b19f)
4. Craft: the "Task Successfully Created" toast lands bottom-right and leaves. Feedback for a
   completed action is one line, then silence.
   [Mobbin screen](https://mobbin.com/screens/9f0a6cd4-e7c8-4b1a-b9cf-fe3396d61637)

### Chosen expression

- Kick on view activation: when the Calendar tab becomes selected, and when the window
  becomes key while Calendar is selected, the client sends `calendar.resync` with
  `reason: 'view_open'`. The server debounces; the client only reacts to `started`.
- Manual: ⌘R "Sync Calendar" in the Albatross menu (enabled only while Calendar is the
  selected surface). Sends `reason: 'manual_http'`.
- Indicator: a 2pt line directly under the toolbar, full width of the calendar column, in
  the accent color. It is drawn only while a sync runs. Motion: a segment 30% wide moves
  left to right in 1.2 s loops. On completion the segment snaps to full width (120 ms) and
  fades (250 ms). Reduced motion: a static 2pt line, then fade.
- Caption: after a sync, a caption appears at the trailing end of the calendar header for
  3 s: "Calendar is current." When ⌘R runs but the server returns `started: false`, the
  caption reads "Synced 40 s ago." for 2 s and no line draws. Feedback with no work.
- Error: the caption reads "Sync did not finish. Try again." and stays until the next
  kick. Click on the caption runs ⌘R.
- Post-mutation: a created event renders at once with a dashed 1pt outline. When the server
  copy arrives (about 5 s), the outline becomes solid (200 ms). The attendee status fills in
  the same frame. Nothing else moves.
- Hover: the caption has a tooltip with the exact time: `.help("Last sync 09:41")`.
- States: idle (nothing drawn), running (line), done (caption, 3 s), failed (caption,
  persistent). No modal, no spinner in the toolbar. The line follows the column at any width.

---

## Wave C. The lean brief in a reading pane

### Findings

1. Plain (support desk): the thread reader shows the real message first, then a "Summary"
   block under it. The summary never replaces the source.
   [Mobbin screen](https://mobbin.com/screens/6b03543c-d8bd-403c-a3eb-3c43783a0a23)
2. Wrangle: list + reader in one window; the selected row is a plain highlight and the
   reader shows the full email. [Mobbin screen](https://mobbin.com/screens/21f78fb6-24b8-438b-8932-5f6945f28f3c)
3. Apollo email list: sender, subject, and a one-line message preview in a single row.
   [Mobbin screen](https://mobbin.com/screens/e1f96fb0-7e72-484d-bb48-4a60c67270a4)
4. Linear Inbox: H snoozes a notification and hides it "until the selected time"; a
   display toggle shows snoozed items again. (https://linear.app/docs/inbox)
5. Tana daily report: sections with numbered headings and short sentences; the reader is a
   document, not a dashboard. [Mobbin screen](https://mobbin.com/screens/d1f5b0a9-80b1-49f0-88c6-cceb833fe0a7)

### Chosen expression

Today on the Mac becomes two panes, like Mail: "the letter" and "the day".

- Left pane (min 420, ideal 520, max 640): the letter. Masthead, then the lede in the body
  face (max 4 sentences), then three sections with section rules: "Answer", "Today",
  "Know". Then "The week ahead" prose. Then "Areas": at most 3 lines.
- Each item is an email row, not a card: initials avatar, sender display name, subject,
  and one reason line in the accent-3 status voice. The trailing action is one plain verb:
  "Reply", "Open", or "Read". Rows are selectable. ↑ and ↓ move the selection. Return opens.
- Right pane (min 440): at rest it shows the day. The day ribbon runs vertically at scale,
  with the "Next move" line pinned under it. When a row is selected, the day pane gives way
  to the thread (`ThreadView` with the thread route). Esc returns to the day.
- Week-ahead prose: weekday names are links in the primary color with an underline on hover.
  Click selects that day in Calendar. This is how the paragraph lands as something you can act
  on without a control row.
- Area lines: "Area name: last change in one sentence." Click opens the area.
- Motion: on first render of an edition, rows fade and rise 4pt with a 40 ms stagger,
  once. Selecting a row crossfades the right pane (180 ms). No motion on scroll.
- Window under 900pt wide: the panes become one column and a row click pushes
  the thread as today.
- States: no edition, the left pane shows the masthead and one line "There is no edition for
  today yet." with the button "Write today's brief". Composing: rows appear as they land, with
  the progress line from Wave B reused under the masthead. Error: "Could not load today's
  brief." with "Try again". Stale: the standing line turns orange as it does today.
- The brief document keeps the v2 node tree. The Mac view reads the hero node for the lede,
  one `entity_list` per lane for the rows, and the text body for the week ahead.

---

## Wave D. Shapes: list, practice, project; how the shape shows and changes

### Findings

1. Perplexity Health: a stat tile with seven-day bars, the current number large, a delta
   under it, and an honest sentence when the data is thin ("Only two days of step data").
   [Mobbin screen](https://mobbin.com/screens/e879169d-0e6e-4105-91df-1befa935e6dc)
2. Copilot Money category detail: a trend line with a dashed target marker and entries
   grouped by day under it. [Mobbin screen](https://mobbin.com/screens/f190d75c-a890-47cc-b966-69eb50b5bc64)
3. HoneyBook automation run: a vertical rail of steps, each with a state tag and a
   timestamp; the current one has an outlined card.
   [Mobbin screen](https://mobbin.com/screens/6b0c0c5b-4b33-4767-a2c1-6baafed1f422)
4. Basecamp To-dos: "Add a to-do" is an inline link at the top of the list, no dialog.
   [Mobbin screen](https://mobbin.com/screens/4304ed03-6265-4fac-94c8-9d2a8eba1b70)
5. Tana To-Do: a flat table of items, completed rows stay in place with a filled mark.
   [Mobbin screen](https://mobbin.com/screens/a701ea6d-c950-4607-861f-17d434e42708)
6. Apple Reminders (Mac): completed reminders leave the open list; "scroll to the top of a
   list to see its completed reminders." (https://support.apple.com/guide/reminders/remndbeda47c/mac)

### Chosen expression

Shape word (all shapes):

- Under the Work title, the shape word sits in the italic display voice: "List",
  "Practice", "Project", "Quick", "Decision", "Monitor", "Routine". It is a menu button.
- The menu lists every shape with one line each, for example "List. Items only. No plan,
  no checks." Choosing a shape calls `work.setShape`. When the change removes plans or
  checks, a one-line confirmation reads: "Steps and checks stop. Items stay." with
  "Change" and "Keep".
- Work list rows show the shape word in the caption line after the state.

List detail (Mac):

- No header chrome. The first row is a plain text field with placeholder "Add an item".
  Return adds the item and keeps focus so the next item can follow. Esc clears the field.
- One line per item with a checkbox. Click checks it. A checked item moves to the bottom
  of the list over 280 ms (`.snappy`). Unchecking lifts it back.
- Hover on a row shows a trailing text button "Remove". The Delete key removes the
  focused row. The store's undo notice offers "Undo".
- Empty: only the field shows. Error: "Could not save that item." under the field.

Practice detail (Mac):

- Top: the current value large in the display face, the unit in the caption voice, the
  target after it: "182.4 lb · target 170".
- A sparkline (Canvas) from the entries, height 96, full column width. The target is a
  thin dashed horizontal line. Hover shows a vertical hairline with the value and date
  of the nearest point. The line draws in over 600 ms when the view opens; reduced motion
  skips this.
- One button, "Log", opens a popover: a number field with the unit, an optional note.
  Return logs. ⌘L opens the popover.
- The weekly review is one sentence from the numbers, on device: "Two logs this week.
  0.8 lb below last week." Streak line: "6 weeks with a log." With one entry: "One log so
  far. The trend starts at the second."
- Empty: "No logs yet." and the "Log" button. Error: "Could not save that log."

Project detail (Mac):

- A vertical rail of milestones. Done: filled dot. Current: open ring in the accent color.
  Rest: hollow hairline dot. Title next to each dot. Click a dot to toggle; the fill scales
  in over 200 ms. Hover on a row shows "Mark done" or "Reopen" as text.
- Rows reorder by drag. The last row is a field "Add a milestone". ⇧⌘M focuses it.
- Under the rail: "Last touched 3 days ago." then the log of artifacts in time order
  (commits, pull requests, documents), each a plain row with a date.
- Empty: the field only. Error: "Could not update the milestone."
- Window sizing: shape views keep the 840pt reader column; the sparkline follows its width.

---

## Wave E. One bar for Ask and Hold

### Findings

1. Tana home: one field with placeholder "Ask or Capture…" and route chips under it.
   The same bar serves both intents. [Mobbin screen](https://mobbin.com/screens/572a2ee5-025a-4fcc-89a4-3b6fb354df19)
2. Higgsfield composer: the mode chip sits at the right edge of the input, next to the send
   button. [Mobbin screen](https://mobbin.com/screens/b3d37b95-b6a7-4d0b-a069-4239a27452f1)
3. Devin command menu: key hints in the footer ("Navigate", "Close", "Select").
   [Mobbin screen](https://mobbin.com/screens/274435b9-f420-4a7c-ab68-82514c1419f9)
4. Mistral Le Chat: a "Think" toggle chip at the right edge of the field, one word.
   [Mobbin screen](https://mobbin.com/screens/edacf670-c966-421c-85ec-ad218e18a549)
5. Raycast: type a question in the root bar and press Tab to get the answer in the same
   window; ⌘K opens the Action Panel for the selected item. Linear lists each command three
   ways: keyboard, mouse, command menu. (https://manual.raycast.com/ai/quick-ai,
   https://manual.raycast.com/action-panel, https://linear.app/docs/search)
6. Amie: typing "@list @2pm" in the field parses in place and the item lands in the list
   with those fields set. [Mobbin flow](https://mobbin.com/flows/6c17416d-c6c5-445a-9c89-6f5301e5a860)

### Chosen expression

The bar in the chat panel:

- The composer keeps its shape. A route chip sits inside the field at the trailing end,
  before the send button. It reads "Ask" or "Hold". Accent-1 fills Ask, accent-2 fills Hold.
- Prediction: after 250 ms of no typing and at least three words, the client calls
  `assistant.route`. While the call runs, the chip keeps the last value at 60% opacity. Under
  0.6 confidence the chip stays at 60% opacity until the user flips it or types more.
- Tab flips the chip when the field has text. Tab with an empty field moves focus as normal.
  The flip is a 120 ms vertical roll of the word (the old word moves up and out, the new word
  moves in from below).
- Return on Ask sends the message. Return on Hold captures.
- Hold landing (under 600 ms): the field becomes a card in place (180 ms). The card
  shows the title, the shape word, and the horizon line. It holds 250 ms. Then the card moves
  to the sidebar's "Albatrosses" row (170 ms, ease-in) and the row text becomes bold for
  one frame. The composer returns empty. Reduced motion: crossfade only.
- Capture failure: the card turns back into the field with the text kept, and one line
  reads "Albatross could not hold that. Try again."
- Route timeout: the chip falls to "Ask" with no message.

"Hold this" on a reply:

- A text action row under each assistant reply: "Copy" and "Hold this". It shows on hover,
  and always on the latest reply. Click posts the reply plus the user's message with
  `source: 'chat'`. The reply gets a 1pt accent-2 outline and a foot line "Held as
  {title}." with a text link "Open".

The ⌘K position when the panel is closed:

- ⌘K opens a floating bar centered at one third of the window height, width 560. One field
  with placeholder "Ask, or hold some work." The route chip sits in the same position. A
  footer reads "Tab flips · Return sends · Esc closes".
- Ask: the bar closes, the chat panel opens, and the message sends.
- Hold: the Hold landing plays from the bar, the card moves to the sidebar row, the bar
  closes.
- When the panel is open, ⌘K focuses the panel's composer. ⇧⌘K shows or hides the panel.
  The Albatross menu gets "Ask or Hold…" (⌘K) and "Chat Panel" (⇧⌘K).
- The bar opens with a 160 ms fade and 6pt drop. Esc closes it. Click outside closes it.
  Under 640pt window width the bar is the window width minus 40pt.

---

## Component plan

Shared views that get a Mac branch (`#if os(macOS)` inside `apps/ios/Lab86Mail/**`):

- `Features/Today/TodayView.swift`: drop the stack sections; add the Mac two-pane mount and
  the selectable email rows. State: `selectedBriefItem`, `readerRoute`.
- `Features/Work/WorkView.swift`: Later shelf mount (horizontal on Mac, vertical on
  iOS); hover review row. State: `laterItems`, `reviewingItem`.
- `Features/Work/WorkDetailView.swift`: route by shape to the shape views; horizon button and
  popover placement. State: `showsHorizonPopover`, `showsShapeMenu`.
- `Features/Assistant/AssistantChatView.swift`: route chip, Tab flip, Hold landing, hover
  actions on replies. State: `route`, `routeConfidence`, `routePending`, `landingPhase`.
- `Features/Calendar/CalendarView.swift`: sync line mount, `view_open` kick, ⌘R handler.
  State: `syncState`.
- `App/AlbatrossCommands.swift`: ⌘K "Ask or Hold…", ⇧⌘K "Chat Panel", ⌘R "Sync Calendar",
  ⇧⌘H "Horizon…", ⌘L "Log…", ⇧⌘M "Add Milestone".
- `Features/Shell/NavigationModel.swift`: `askHoldBarPresented`, `briefReaderRoute`.
- `Core/Models/ProductStore.swift`: `calendarSyncState` (idle, running, done, failed),
  `calendarLastSyncedAt`, `wakeNudgeQueue`, and the new mutations mapped to commands.

Shared shape views (new, under `apps/ios/Lab86Mail/Features/Work/Shapes/`, with Mac branches
for hover and keys): `ListShapeView`, `PracticeShapeView`, `ProjectShapeView`,
`ShapeWordMenu`, `HorizonPopover`, `LaterShelfView`, `MetricSparkline`, `SyncProgressLine`.

Mac-only views under `apps/ios/Lab86MailMac/`:

- `Shell/MacTodaySplitView.swift`: the letter + the day. State: `readerRoute`.
- `Shell/MacAskHoldBar.swift`: the ⌘K bar. State: `text`, `route`, `landingPhase`.
- `Shell/MacHoldLanding.swift`: the card flight overlay in window coordinates. State:
  `sourceFrame`, `targetFrame`, `card`.
- `Shell/MacWakeNudge.swift`: the trailing-edge bar. State: `nudge`, `timerPaused`.
- `Shell/MacLaterRuler.swift`: the horizontal ruler layout for the shelf. State:
  `focusedCardID`.

Tests (names only): `HorizonRulerSpacingTests`, `SyncLineStateTests`, `RouteChipFlipTests`,
`HoldLandingPhaseTests`, `BriefRowSelectionTests`, `ListOrderTests`, `WeeklyReviewSentenceTests`,
`MilestoneToggleTests`, `CommandShortcutMapTests`.

---

## Risks and what to avoid

- Tab inside a SwiftUI `TextField` on the Mac moves focus by default. Use `onKeyPress(.tab)`
  only when the field has text, and add a unit test on the decision function. Do not break
  focus travel for an empty field.
- ⌘K changes meaning (bar, not panel). Keep ⇧⌘K for the panel and put both in the menu so the
  shortcut is discoverable. Do not add a third shortcut for chat.
- Hover-only actions are invisible to keyboard and VoiceOver. Every hover action needs a
  context-menu or key path (Delete, Return, ⌘L, ⇧⌘M).
- `matchedGeometryEffect` across `NavigationSplitView` columns is unreliable. Draw the Hold
  landing card in a window overlay with frames read from `GeometryReader` in the global space.
- Horizontal scroll with a mouse wheel does not work without ⇧. The ruler must also accept
  ← and → and must fall back to a vertical list under 640pt.
- Sparkline with one or two points: draw the point and the target line only. Never draw a
  trend from one entry.
- Do not put custom progress or tinted backgrounds in the Liquid Glass toolbar (HIG,
  2025-12-16). The 2pt line sits under the toolbar in the content area.
- Linear un-snoozes an item on new activity. Albatross must not: dormant Work stays dormant
  until `notBefore`, even when mail about it arrives.
- Do not double the feedback. The card flight is the Hold confirmation; no toast follows.
  The sync caption is the sync confirmation; no alert follows.
- `WorkDetailView.swift` is already 586 lines. Shape views go in their own files.
- Keep the brief document v2 node tree. The Mac view is a new reader over the same nodes; do
  not change the composer output for the Mac.
- Do not add a menu-bar extra (the Notion Calendar pattern) or multiple-window scenes in
  this round. Record them as later work in `docs/mobile/macos-target.md`.
- Reduced motion must remove the roll, the flight, the stagger, and the draw-in.
- Never write "AI" in copy. Never place an icon before text in a button.
