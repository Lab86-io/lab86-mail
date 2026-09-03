# Web design note: refinement round 2026-09-03

Status: planning. Owner: Claude (web design research). Written 2026-09-03.

This note gives the web expression for the five waves in `docs/refinement-round-2026-09-03.md`.
It is an input to the web implementation subagent and contains no product code.

## Ground rules for each wave

- Tokens: `--color-accent` (action), `--color-accent-2` (editorial voice), `--color-accent-3`
  (status and data). Depth comes from `--color-bg`, `--color-bg-subtle`, `--color-bg-elevated`,
  `--color-bg-muted`, and `--shadow-soft`. Do not add a class ladder.
- Movement: `--duration-fast` (150 ms), `--duration-normal` (200 ms), `--duration-moderate`
  (300 ms), `--ease-enter`, `--ease-exit`. Add movement only where it gives information. With
  `prefers-reduced-motion` each movement below becomes a 0 ms state swap.
- Copy: plain verbs, no icon before text, no sparkle or star, no ALL-CAPS label, not the word
  "AI". Serif display for titles, sans for body and controls.
- Mobbin was available. Screens are cited by app and Mobbin URL. Browserbase is the last section.

---

## Wave A. Today cleanup, Later shelf, horizon control, wake nudge

### Findings

1. Amie: the todo list groups "No date / Later / Completed" with a date chip at the row end.
   https://mobbin.com/screens/9dd98542-f146-4330-82da-1abaa38a3ef2
2. ClickUp Inbox: tabs "Primary / Other / Later / Cleared" and a row line "Unsnoozed on Oct 24".
   The wake date is a fact on the row, not a badge.
   https://mobbin.com/screens/bc1ba74d-c344-40c0-b43b-c2815a956764
3. Featurebase snooze: one field "Type a date like 'in 3 days', 'next friday'" above quick rows
   with the resolved absolute date on the right.
   https://mobbin.com/screens/932552b9-2762-4737-906e-4fca48049a2a
4. Things 3 (Browserbase section): a Someday item does not surface on its own; a start date
   moves it into Today on that date.

### Chosen expression

Today. Remove `ReEntry`, `ReviewBatch`, `MissedMovesRecoverySection`, "Needs you", "Ongoing
practices", "Waiting, not forgotten", and the "Get this off my mind" button from `TodaySurface`.
Today keeps, in this order: `BriefMasthead`, the capacity header, a two-column grid with "Do this
next" (only when `execution.currentMove` is present) and "Important mail" (max 4 rows) on the
left and `DayRibbon` on the right, then the brief. An empty left column shows one line: "Nothing
is scheduled. The day is yours." The `LapsePrompt` strip in `CalendarSurface` is removed too.

Later shelf on the Work page (`AlbatrossesSurface`). A section "Later" sits below the open
groups. It is a horizontal rail, not a list:

- Layout: one row that scrolls on the x axis, `no-scrollbar`, snap to card. A hairline in
  `--color-border` runs the full width at the vertical center. Cards sit on the hairline like
  stops on a route. Each card: serif title (16 px, one line, ellipsis), a `--color-accent-3` line
  from `horizonLine` ("Back on Nov 1", "By Friday"), and the user's words from `horizon.label` in
  muted italic. Cards with `notBefore` sort by date. Cards with `kind: 'someday'` sit after a gap
  below a faint word "Someday". Small mono month labels above the hairline mark month starts.
- States: empty, the section does not render. Woke today: a 1 px `--color-accent` top edge and
  the line "Back now". Hover: lift to `--color-bg-elevated` with `--shadow-soft`, 150 ms. Click
  opens `WorkDetail`.
- Keyboard: `role="list"`; Left and Right move between cards; Enter opens.
- Responsive: below 640 px the rail becomes a vertical list with the date on the right edge.

Horizon control (`WorkDetail` actions cluster, and the `IntentCapture` sheet after a split).
One control, `HorizonControl`:

- A segmented track in the `AreaViewSwitcher` style with `Now`, `Later`, `Someday`. The active
  segment slides, 200 ms `--ease-enter`.
- When `Later` is active, one text field appears below the track with placeholder "in two weeks,
  after the wedding, not before November". `parseHorizonHint` runs on each keystroke. The parsed
  phrase gets a `--color-accent-3` underline and the resolved line ("Back on Nov 1") shows right
  of the field. When the parse fails the right side reads "Pick a date" and a native date input
  replaces the field on click.
- Enter saves. Escape returns to the previous value. Saving: the resolved line fades to 55%
  opacity for the request. Error: "Could not save the horizon. Try again."
- On save from `WorkDetail`, the row leaves its group with a 200 ms fade and the Later rail gains
  its card with a 200 ms slide in from the right edge.

Wake nudge. A `WakeNudge` in the shell, not a sonner toast, anchored to the right edge at the
top of the content area. Content: the `wakeLine` text ("Passport renewal is back. Ready when you
are.") and text buttons "Open" and "Later" (the second opens the horizon control inline). It
slides in 24 px from the right, 300 ms `--ease-enter`, and stays. It leaves with 200 ms
`--ease-exit` on Open, Later, or close. Wakes stack, newest on top, max 3. Escape closes the top
one; Enter opens it. Source: `albatrossNotifications` rows from the wake cron.

### Component plan

- Change: `components/report/TodaySurface.tsx` (remove the stack, keep four regions),
  `components/calendar/CalendarSurface.tsx` (remove the `LapsePrompt` strip),
  `components/albatross/AlbatrossesSurface.tsx` (add the Later section, exclude dormant Work from
  the open groups), `components/albatross/WorkDetail.tsx` (horizon control in the actions
  cluster; missed moves show only here).
- New: `components/albatross/LaterShelf.tsx` (`items`, `nowMs`, `onOpen`),
  `components/albatross/LaterCard.tsx` (`work`, `nowMs`, `active`, `onOpen`),
  `components/albatross/HorizonControl.tsx` (`value`, `nowMs`, `onChange`, `saving`, `error`,
  `autoFocus`), `components/shell/WakeNudge.tsx` (`notifications`, `onOpen`, `onLater`,
  `onDismiss`).
- Shared helpers are present in `lib/albatross/horizon.ts`.

### Risks and what to avoid

- Do not draw the rail as a Gantt chart (Plane, Airtable). One hairline and cards. No bars.
- Do not show a calendar grid by default (Evernote). Natural language first, date input second.
- Do not repeat the wake as a toast and as a row. The nudge is the only wake surface.
- Cap the rail height at 120 px so it does not push the open groups below the fold.

---

## Wave B. Calendar sync state on view open and pull

### Findings

1. Skiff Calendar: a small "Syncing" chip in the header, and a toast "Import started. Keep the
   page open until the import is complete." for the first import only. The steady state has no
   chrome. https://mobbin.com/screens/e71a3618-e975-4970-8e69-67d0c8d6b157
2. Proton Calendar: a card with a thin progress bar and "72/370" for a one-time index. Numbers
   only when they mean something. https://mobbin.com/screens/f8e4a8f8-89da-40e2-906c-faebb60b4b63
3. Square Appointments: a "Last synced" column with a timestamp. The fact is stated, not
   animated. https://mobbin.com/screens/ae4d1f7b-a50e-4388-9654-18ff43eb21c6
4. Clockwise: history reads "Alex marked this event as flexible, an hour ago". A relative time
   reads faster than a timestamp. https://mobbin.com/screens/e7054460-8119-4b7c-a9d9-1988b42c30ca

### Chosen expression

One thin line and one short sentence. No pulsing dot strip.

- `SyncLine`: a 2 px bar fixed to the top edge of the calendar frame in `--color-accent-3`. On
  `started: true` it grows from 0 to 70% width over 800 ms `--ease-enter`, holds, then runs to
  100% and fades in 200 ms when the live query reports the sync finished. With reduced movement
  it is a static 2 px line for the sync, then gone.
- The "syncing" strip becomes one muted sentence in the calendar header, right of the date
  navigator, 12 px: "Synced 4 minutes ago". During a sync it reads "Syncing". After a failed kick
  it reads "Could not sync. Try again." and the sentence is a button.
- View open: `CalendarSurface` posts `{ reason: 'view_open' }` once per mount. When the response
  returns `started: false` nothing moves. The sentence updates from `lastSyncedAt`.
- Pull: on a touch device a pull of 64 px on the calendar body posts `{ reason: 'pull' }`. The
  body offsets with resistance (offset = pull * 0.4, max 48 px) and springs back in 300 ms. On a
  pointer device the sentence is the control: click or Enter posts `{ reason: 'manual_http' }`.
- Post-mutation: the client does nothing extra. The shared layer kicks the sync and the
  `SyncLine` shows. Attendee status fills in with a 150 ms color transition on the block.
- Copy: "Synced just now", "Synced 4 minutes ago", "Syncing", "Not synced yet".

### Component plan

- Change: `components/calendar/CalendarSurface.tsx` (replace the syncing strip, post `view_open`
  on mount, wire pull and the sentence button, remove `LapsePrompt`).
- New: `components/calendar/SyncLine.tsx` (`active`, `reduceMotion`),
  `components/calendar/SyncStatus.tsx` (`lastSyncedAt`, `syncing`, `error`, `nowMs`, `onResync`),
  `components/calendar/usePullToResync.ts` (`threshold`, `onPull`).
- Shared: `lib/calendar/sync-copy.ts` with `syncedLine(lastSyncedAt, nowMs)`.

### Risks and what to avoid

- Do not show event counts during a sync. They mean nothing to the user.
- Do not use `animate-pulse`. A pulse with no end reads as a stuck state.
- Do not block the header with a modal or a card (Proton). The calendar stays usable.
- The 70% hold must not run for ever. Cap the line at 20 s, then show the error sentence.

---

## Wave C. The lean brief

### Findings

1. Medium Daily Digest: a masthead, a small kicker "Today's highlights", then each item as
   author, title, and one-line teaser. Real content, one line of framing each.
   https://mobbin.com/screens/2e3c0aef-3a13-4993-a9f0-9011e2cc8ea1
2. Fabric weekly note: headings "Summary / Key updates / Next steps / Notes" with short
   sentences and no cards. https://mobbin.com/screens/47089f58-97dd-453d-8307-566c72f34d67
3. Obvious "Q1 Design Recap": a dek below the title, then an executive summary paragraph. The
   lede sits above all and carries the voice.
   https://mobbin.com/screens/48ebdb36-0d47-4585-8e92-fee7b45133f8
4. Gmail nudges (Browserbase section): one short reason line per mail with the age of the thread
   in it, "Sent 5 days ago. Follow up?".

### Chosen expression

The brief reads top to bottom in one measure, 620 px max. Four parts:

1. Lede. The `hero` node with `text` role `lede` in `--font-display`, 22 px, max 4 sentences.
   No card border. A dinkus divider follows (the `flourish` rule that is already present).
2. Emails as emails. Each lane (`answer`, `today`, `know`) is one `entity_list` with variant
   `rows`. Each row is a real email row, not a card: sender in serif 15 px, subject in sans
   14 px, one muted 13 px line on why it matters, and one text action on the right ("Reply",
   "Open", "Add to Work"). The lane label is a kicker in `--color-accent-2`: "Answer", "Today",
   "Know". A lane with zero rows does not render. The document does not show more than the
   budget (5, 7, or 9 rows).
3. Week ahead. One `text` body node, max 4 sentences. Weekday names render in `--color-accent-3`
   weight 500. The renderer marks weekday names with a regex, not the model.
4. Areas. At most 3 lines, each `area name · prose`, in a `stack` of `text` role `caption`. Click
   on the area name opens `AreaHome`.

Footer, muted: "42 other messages did not need you today." States. Loading: the masthead renders at once, then a skeleton of one lede block and three rows;
streamed rows use the `.blur-in` stagger (120, 170, 205 ms, then +60 ms each). Empty: "Nothing
needs an answer today. The week ahead is below." with the week-ahead node. Error: "The brief did
not write today. Write it again." with the "Write it again" control. Done: the freshness stamp
reads "Written at 07:02".

Keyboard: J and K move between rows; Enter runs the row's first action; R runs "Reply".
Responsive: the action drops below the why line below 480 px.

### Component plan

- Change: `components/report/DailyReport.tsx` (remove `BulkTail`, the six `SECTION_LABELS`
  sections, and the three lane tiles; the fallback renders the same four parts from
  `sections`), `components/report/brief-canvas/BriefEntityList.tsx` (a `mail` row style),
  `BriefNodeView.tsx` (weekday marks in `body` text, `caption` stack for areas),
  `components/albatross/AreaHome.tsx` (render the structured pulse, drop the HTML artifact frame).
- New: `components/report/brief-canvas/BriefMailRow.tsx` (`sender`, `subject`, `why`, `action`,
  `onAction`, `focused`), `components/report/brief-canvas/WeekAheadText.tsx` (`text`, `nowMs`),
  `components/report/BriefSkeleton.tsx` (`rows`).
- Shared: `lib/mail/brief-score.ts` and the composer changes belong to the shared layer.

### Risks and what to avoid

- No lane tiles with counts (the current front-page tiles). A count is a summary of a summary.
- No cards inside cards. The lede has no border. Rows have hairlines only.
- Do not color the whole row by lane. Only the kicker carries `--color-accent-2`.
- Do not let the model write weekday markup. The copy stays plain text for native hydration.

---

## Wave D. Shapes: list, practice, project, and how shape shows

### Findings

1. Superlist: a list page is a serif title and rows with a hollow circle, no toolbar.
   https://mobbin.com/screens/d34aae12-2518-42d7-8fbe-636dc90f36d1
2. Craft Tasks: rows of checkbox and one line of text. The list has no header chrome.
   https://mobbin.com/screens/b9636a44-c5ba-4308-9550-2265ae45f731
3. Asana Goal: tiles "Current value 50%" and "On track", one quiet area chart, and one button
   "Update progress". https://mobbin.com/screens/871d4347-8706-440e-924c-88829821c132
4. Linear Project: a "Milestones" list with a diamond marker, a percent, and a date per row, and
   an "Updates" tab with dated prose. Milestones are a rail, not a board.
   https://mobbin.com/screens/ed6163fd-12f3-4aad-a6ed-62707cb7c21e

### Chosen expression

Shape on the page. `WorkDetail` reads `shape` and picks a body from
`lib/albatross/shape-policy.ts`. The `OutcomeHeader` facts row changes by shape: `quick` keeps
"State / Next move / Last proof"; `list` shows "Items / Done / Added"; `practice` shows "Now /
Target / Weeks logged"; `project` shows "Milestones / Last touched / Next".

Shape control. The shape word in the header is a text button. It opens `ShapeControl`: a vertical
list of the seven shapes, each with one line: "list · Keep things. No steps." "practice · Log a
number over time." "project · Milestones and a log." The current shape is bold. A choice calls
`setShape` and the body swaps with a 200 ms cross-fade. Up and Down move, Enter picks, Escape
closes.

List body (`ListBody`). No header chrome. A quick-add line at the top: a text field with
placeholder "Add" and no button; Enter adds and keeps focus; pasted lines add several. Each item
is a row with a hollow circle and text. Click on the circle checks it: the circle fills in
`--color-accent` in 150 ms, the text drops to 55% opacity, and after a 400 ms hold the row moves
to the bottom with a 300 ms `--ease-enter` layout move (the "settle"). Uncheck moves it back the
same way. Hover shows a text control "Remove"; on touch a 500 ms long press shows it. When more
than 5 items are done a text control "Hide done" appears at the bottom. Empty: "Nothing on the
list yet." Error: the item stays at 55% opacity with one line "Could not save. Try again."

Practice body (`PracticeBody`). Top row: the current value in `--font-display` 40 px with the
unit in 16 px muted, the target as a thin `--color-accent-3` marker on the trend, and the
direction in the fact row ("down to 170 lb"). The trend is the `Sparkline` from
`components/tool-ui/stats-display`, 56 px tall, 12 weeks wide, dots on weeks with a log. Below it
one line computed on device by `lib/albatross/practice-review.ts`, no model call: "Down 2.4 lb in
3 weeks. Logged 3 of the last 4 weeks." One button "Log" opens an inline field: number, unit
shown, optional note, Enter saves. The new dot draws in 300 ms. Empty: the number reads "—" and
the line reads "Log the first number to start the trend."

Project body (`ProjectBody`). A vertical rail on the left: 12 px circles joined by a 1 px line.
Done circles are filled `--color-accent`; the current one is hollow with a 2 px `--color-accent`
ring; the rest are hollow `--color-border-strong`. Each milestone: serif 16 px title and a muted
line "Done Aug 12" or "Next". Click on a circle toggles it; the fill grows from the center in
200 ms and the line to the next circle fills in 300 ms. A text control "Edit milestones" turns the
rail into a plain text area, one milestone per line; Enter saves through `setMilestones`. Below
the rail the log: artifacts in time order (commit, PR, doc), each a row with a source word, title,
and relative time. Empty rail: "Add the first milestone."

Chat adds through `albatross_list_add` land live with the same settle. Responsive: the practice
number and trend stack below 480 px. The project rail keeps a 24 px left column on each width.

### Component plan

- Change: `components/albatross/WorkDetail.tsx` (branch on shape; hide plan, steps, proof, and
  completion cards for `list` and `practice`), `components/albatross/primitives.tsx`
  (`OutcomeHeader` accepts `facts` so each shape supplies its three).
- New under `components/albatross/shapes/`: `ShapeControl.tsx` (`value`, `onChange`, `open`,
  `onOpenChange`), `ListBody.tsx` (`workId`, `items`, `onAdd`, `onToggle`, `onRemove`),
  `ListRow.tsx` (`item`, `onToggle`, `onRemove`), `PracticeBody.tsx` (`workId`, `metric`,
  `entries`, `nowMs`, `onLog`), `MetricLogField.tsx` (`unit`, `onSave`, `onCancel`),
  `ProjectBody.tsx` (`workId`, `milestones`, `artifacts`, `onToggle`, `onSetMilestones`),
  `MilestoneRail.tsx` (`milestones`, `onToggle`), `ProjectLog.tsx` (`artifacts`).
- Shared: `lib/albatross/practice-review.ts` (`reviewLine(entries, metric, nowMs)`).

### Risks and what to avoid

- No progress percent on a list or a project (Linear's "77% of 15"). Count and date only.
- No confetti or completion celebration (ClickUp). The settle is the reward.
- No chart chrome on the practice: no axes, no grid, no legend. Dots and one line.
- The shape word must not be a colored badge. It is a text button in the header.
- Do not run the model for the weekly review line.

---

## Wave E. One bar for Ask and Hold

### Findings

1. ChatGPT Codex: the input reads "Ask a question with /plan" and a toggle "Code / App / Docs"
   changes what Enter does. The mode is visible before Enter.
   https://mobbin.com/screens/b08b256c-07cf-474d-9dc1-14c5dc992c4f
2. Base44: one word "Plan" at the right edge of the composer before the send control. One word
   with no icon is sufficient for a mode. https://mobbin.com/screens/82c82260-cb48-4a18-bb4e-fd600abe7a9e
3. Expensify: "Confirm task" opens as a right pane with Title, Description, and one button. The
   card shows what will be kept before it is kept.
   https://mobbin.com/screens/e292ff7c-6143-47c0-9419-58c35113e5aa
4. Superhuman "Remind me" and Arc Site Search (Browserbase section): Tab flips a mode inside one
   bar, and the flipped state is visible before Enter.

### Chosen expression

One bar in `AssistantChat` (`components/shell/AIBar.tsx`). The textarea keeps its placeholder
"Find, draft, schedule, label, anything…". A `RouteChip` sits in the bar at the right edge, before
the send control.

- The chip reads `Ask` or `Hold`. It is a rounded-full text chip, 11.5 px, weight 500. `Ask` uses
  `--color-accent-soft` and `--color-accent` text. `Hold` uses `--color-accent-2-soft` and
  `--color-accent-2`. A small mono hint "Tab" sits left of the chip in `--color-text-faint`; it
  hides below 480 px.
- Route prediction: 250 ms after the last keystroke the client posts to `/api/albatross/route`.
  While the request runs the chip keeps its last value at 70% opacity. On return the chip flips
  with a 150 ms vertical flip (the old word moves up 6 px and fades, the new one comes from 6 px
  below). With reduced movement the word swaps.
- Tab flips the route by hand and locks it for this text. A locked chip shows a 1 px solid border.
  A blank field unlocks. Shift+Tab moves focus as usual.
- Enter on `Ask` sends to chat, as today. Enter on `Hold` runs the Hold landing. Empty text: the
  chip reads `Ask` at 55% opacity and Tab does nothing. Route error or timeout: `Ask`, no message.

The Hold landing, in less than 600 ms total:

1. 0 to 200 ms: the text collapses to a single serif line, the textarea eases to one row, and the
   chip moves to the left of the title. The bar border changes to `--color-accent-2` at 35%.
2. 200 to 400 ms: two lines fade in below the title: the shape word ("list", "quick", "project")
   and the horizon line ("Back on Nov 1", "By Friday", or nothing). This is the parsed card. Its
   data comes from the `captureWork` response.
3. 400 to 600 ms: the card moves to the Work rail: it translates toward the rail edge, scales to
   0.92, and fades, 200 ms `--ease-exit`. The rail row appears in place with a 200 ms fade. The
   bar returns to empty with the `Ask` chip.

With reduced movement the card shows for 600 ms, then the bar clears. When the capture fails the
bar restores the text and shows one line below the bar: "Could not keep this. Try again."

"Hold this" on a reply. Each assistant message with a plan-like body gets a text control "Hold
this" at the end of its action row. Click posts the reply and the user's message to
`/api/albatross/capture` with `source: 'chat'`. The control changes to "Kept" for 2 s and the
same rail row appears. The chat message stays unchanged.

Keyboard: Tab flips, Enter runs the route, Escape clears the field, Cmd+Enter always sends to
chat regardless of the chip.

### Component plan

- Change: `components/shell/AIBar.tsx` (`AssistantChat` gains the route state, the chip, the
  landing, and the "Hold this" control on messages), `components/albatross/IntentCapture.tsx`
  (the `captureWork` client call moves out so the bar and the capture sheet share it).
- New: `components/shell/RouteChip.tsx` (`route`, `locked`, `pending`, `disabled`, `onFlip`),
  `components/shell/HoldLanding.tsx` (`title`, `shape`, `horizonLine`, `phase`, `railTarget`,
  `onDone`), `components/shell/useRoutePrediction.ts` (`text`, `delayMs`, `locked`),
  `components/shell/HoldThisControl.tsx` (`messageId`, `conversationId`, `onKept`).
- Shared: `lib/albatross/route-client.ts` (`predictRoute(text, signal)`, 3 s timeout, `ask` fallback).

### Risks and what to avoid

- One chip, one word. No icon in the chip. No dropdown of modes (Langdock, v0).
- The landing must not show a chat reply. Enter on `Hold` produces no assistant turn.
- Do not flip the chip from a stale prediction: apply a route only when the request text equals
  the text now. Do not keep chat text as Work without the user's Enter or "Hold this".
- Cmd+K on the web opens the same bar. Do not add a second capture pill next to it.

---

## Browserbase references

Real product behavior read through Browserbase. Each line: product, the behavior, the URL.

- Things 3: Someday items do not surface on their own; a start date puts the item in Upcoming and
  moves it into Today on that date. https://culturedcode.com/things/support/articles/4001304/
- Linear Inbox snooze: the item returns at the time; new activity ends the snooze early; "Show
  snoozed" reveals hidden items. Dormant Work does not wake on mail (policy), so the Later rail
  is always visible instead. https://linear.app/docs/inbox
- Superhuman Remind me: type a time in words; Tab switches "if no reply" to "regardless".
  Precedent for the Tab flip in Wave E. https://new.superhuman.com/remind-me-29124
- Arc Site Search: type a shortcut, Tab flips the bar into that mode, then type and Enter.
  https://resources.arc.net/hc/en-us/articles/20855018192791
- Apple Health Trends: a trend shows only when a change is significant, as a small graph with one
  sentence. https://support.apple.com/guide/iphone/view-your-health-data-iphe3d379c32/26/ios/26
- Apple Reminders: a "Completed" row with "Show" hides done items ("Hide done" follows this).
  https://support.apple.com/guide/reminders/mark-reminders-complete-or-incomplete-remndbeda47c/mac
- Fantastical: the parsed date phrase is marked inline as the user types and a preview updates
  live. https://flexibits.com/fantastical/help/adding-events-and-tasks
- Gmail nudges: "Received 3 days ago. Reply?" and "Sent 5 days ago. Follow up?".
  https://9to5google.com/2018/05/14/new-gmail-web-nudge-ai-reminders/
- Linear milestones: target date, a progress indicator, and dated Updates with a health badge.
  The project rail keeps the date only. https://linear.app/docs/project-milestones
