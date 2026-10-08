# Albatross threads, web design note (2026-10-08)

Status: design only. No production code changed. The brief is `docs/albatross-threads.md`
(stories T1–T12, the owner decisions, the server contract). The thread itself is PR 1
(`docs/albatross-thread.md`, its "Cross-platform decisions", and
`lib/albatross/thread-contract.ts`). This note decides how the web list, the rail, and the
steering controls look and behave. iOS and macOS have their own notes.

Mockup: `/tmp/albatross-threads-mockup/index.html`, rendered at 1440×900 (2×):

- `/tmp/albatross-threads-mockup/rail.png`: the rail beside an open thread. A run is in
  progress, a sent note shows "Read by Albatross", and the row "Pay the water bill" has
  Steer open in place.
- `/tmp/albatross-threads-mockup/rail-pane.png`: the same, with the page pane open (three panes).
- `/tmp/albatross-threads-mockup/list.png`: the full list, no thread open, with the hover
  actions on one row.
- `/tmp/albatross-threads-mockup/answer.png`: the full list with "Answer" open in place.
- `/tmp/albatross-threads-mockup/rail-dark.png`: the rail screen in dark mode.

All sample data is invented (Sam Rivera, dmv.ny.gov, springfieldwater.example.gov, 555 numbers).

## 0. The design in ten lines

1. The list becomes live. Each row shows one status word and one preview line from the
   `albatrossThreads.list` contract.
2. When a thread is open and the window is 1024 px or wider, the list stays open as a 300 px
   rail on the left of the thread. The main app sidebar drops to its 48 px icon mode, so the
   page never has three wide navigation columns.
3. A row has one indicator: a 7 px dot in the status voice. Unread is weight, not a second glyph.
4. Rows that work recede a little. Rows that need you do not. The open thread never recedes.
5. The rail sorts "needs you" first, then "in progress", then by last activity, in three groups.
   Order inside a group does not change while the pointer is in the rail.
6. One click, ⌘↑, or ⌘↓ hops. Each thread keeps its draft, its scroll position, and its focus.
7. While a run works, the composer sends to the run. A route line says so. "Stop and redirect"
   sits on that line.
8. A sent note carries a receipt: "Sent to the run", "Read by Albatross", or "Not read: the run
   ended first" with "Send again".
9. "Answer" and "Steer" work in place in the rail and in the list. The row grows downward.
10. One polite live region for the whole rail, with a short vocabulary, so eight busy rows do
    not flood a screen reader.

## 1. Research findings and the decision each one drives

### 1.1 T3 Code, the owner's reference

Sources, in order of trust: the local checkout at `/home/jjalangtry/repos/t3code` (commit
`1dc8cbe6d1`, 2026-09-25), its user doc `docs/user/thread-sidebar.md`, the generated web guide
(https://mintlify.wiki/pingdotgg/t3code/guides/web-interface), the repository
(https://github.com/pingdotgg/t3code), issue #14872
(https://github.com/pingdotgg/t3code/issues/14872), and PR #7969
(https://github.com/pingdotgg/t3code/pull/7969).

| Finding (file or page) | Decision for Albatross |
|---|---|
| Five visual states, three colours: "color is reserved for act now (approval), in motion (working), and broken (failed). Ready is the unlabeled resting state." Unread is tracked apart from status (`apps/web/src/components/Sidebar.logic.ts`, the `SidebarThreadStatus` comment). | The row has one status dot in four voices (working, waiting, done, failed) plus a hollow dot for idle. Unread is a separate axis: weight and the time colour, never a second glyph (§3.3, §3.4). |
| Working rows recede: `shouldRecedeSidebarThread` returns true for working and monitoring rows, false for input rows and for the active row; ready rows recede once read (`Sidebar.logic.ts:786`). The row class is `opacity-70 … hover:opacity-100 … motion-reduce:transition-none` (`Sidebar.tsx:1406`). | Rows in progress, and read rows that do not need you, sit at 72 % opacity. Hover and focus restore them. The open thread and "needs you" rows never recede (§3.1). |
| "No shimmer: a label that animates forever is noise in a sidebar full of them (and repaints every vsync on high-refresh displays)" (`Sidebar.tsx:1131`). The status pill's `pulse: true` is on the dot only (`resolveThreadStatusPill`). | No shimmer text in the rail. The Brief's `ShimmerText` stays in the Brief. In the rail, motion is one slow halo on the dot of an in-progress row, 2.4 s, and none under reduced motion (§3.3). |
| Unseen completion: `hasUnseenCompletion` is `latestTurn.completedAt > lastVisitedAt` (`Sidebar.logic.ts:635`). Issue #14872: a background shell kept a finished thread at "Waiting", so its unseen "Completed" never showed; "with several agents running, the bright/unread row is how I find threads that need me". | Unread is `lastActivityAt > seenAt` for activity that matters, as the contract says. The rail never lets a secondary live state (a page session that stays open, a queued run) mask an unread finish: unread always wins the weight (§3.4). |
| The time at the right of a row fades on hover and the settle action takes its slot (`Sidebar.tsx:1634`, `group-hover/sidebar-row:opacity-0`). | The hover actions take the time's slot. Nothing shifts (§3.6). |
| Keys: `mod+shift+[` / `mod+shift+]` are `thread.previous` / `thread.next`; `mod+1…9` jump (`packages/shared/src/keybindings.ts:63`). `resolveAdjacentThreadId` does not wrap at the ends (`Sidebar.logic.ts:735`). | ⌘↑ / ⌘↓ outside a text field, ⌥⌘↑ / ⌥⌘↓ everywhere. No wrap. No number jumps in v1 (§4). |
| "Thread activity does not change the order" (`docs/user/thread-sidebar.md`, Pin and reorder). New threads go to the top. The settled shelf sorts by settlement time. | Activity changes a row's group at once, but the order inside a group settles only while the pointer is out of the rail (§3.7). |
| Settling the thread you look at "moves you forward: the next remaining card" (`Sidebar.tsx:3040`). Unpin, settle, snooze, and archive show Undo for five seconds (user doc). | Back from a finished thread stays on the list; Stop from a row does not navigate. No Undo for Stop: a stopped run cannot restart from its page, so the row offers "Handle it" instead (§3.6). |
| Drafts live per thread key in `composerDraftStore.ts`; a draft row in the sidebar shows the first line of the prompt (`Sidebar.tsx:725`). | Drafts are kept per thread. A thread with an unsent draft shows the word "Draft" in the time slot (§4). |
| Right-click "Mark unread" exists (web guide, Managing Threads). | Not in v1; see open question 7. |
| Sections: pinned, active, snoozed, settled (`SidebarSection`). | Three groups in the rail: Needs you, In progress, Carried. "Finished" is a count at the foot, not a shelf (§3.7). |

### 1.2 Mobbin (web, images inspected)

| Screen | Taken | Rejected |
|---|---|---|
| Devin, sessions sidebar beside an open session ([screen](https://mobbin.com/screens/f7e9f607-dc8f-49ab-b42e-26f9270fd31b)) | A recent list at the left, the open session in the centre, a status line under each title ("PR is ready · 1"), a relative time on old rows. | The blue unread dot next to the status line: two indicators per row. |
| Devin, a row at work ([screen](https://mobbin.com/screens/a06da25d-f8cd-4fb3-8316-c581413a9106)) | The status word "Working" under the title, in plain text. | The read rows and the working row have the same weight. |
| Devin, sessions table ([screen](https://mobbin.com/screens/9cd37913-d61d-4807-af23-f2e9f3647df8)) | The prompt as the preview line, the time at the far right. | A status icon per row plus a tag per row. |
| Superhuman, split list ([screen](https://mobbin.com/screens/12017834-ef28-43d5-a046-025c9b88da9a)) | Unread rows are bold; read rows are regular; the preview is in the muted voice after the subject; grouped by day with quiet labels. | The far-left unread dot (our left column is the status dot). |
| Slack, Unreads view ([screen](https://mobbin.com/screens/0369613c-f9aa-4b0f-aa1d-4890687a0d0c)) and the active channel ([screen](https://mobbin.com/screens/7f618164-b18e-456a-8661-8f7d4ec9ebbb)) | Bold for unread; the open item has a filled row background. | Count badges. A count of events is not a count of things that need you. |
| Linear, issues grouped by status with counts ([screen](https://mobbin.com/screens/be6c4ee4-aa93-42b4-89b3-dcfc8386f022)) | Group headers with a quiet count, rows at one line height, time at the right. | An icon before every title. |
| Wrike, grouped list beside the open task ([screen](https://mobbin.com/screens/20ad47f6-2249-48aa-a3c2-e8fb4503b4b0)) | The status word on the second line of the row, under the title. | The avatar column and the tag chips. |
| Cursor, cloud agents sidebar ([screen](https://mobbin.com/screens/7befdaf8-cec9-47ea-8061-44fee9406898)) | A "Today" group; the open agent marked with a filled row. | The model tabs "Task completed" above the reply. |
| Cursor, "Agent is setting things up" ([screen](https://mobbin.com/screens/44239877-86ce-46c8-a615-273ec82046f5)) | Nothing for the rail. The right pane that explains a run is the page pane we have. | "Get notified when finished" as a checkbox in the pane. |
| Claude, recents ([screen](https://mobbin.com/screens/d72b17b4-df91-4813-8e5d-a04d20041570)) and the "notified when Claude responds" strip ([screen](https://mobbin.com/screens/98255484-f7b1-43c3-b9a1-1c6f971de3bd)) | Title-only rows read calm. | Title-only rows: the owner asked for a status preview. The notification strip over the composer. |
| ChatGPT Codex, home ([screen](https://mobbin.com/screens/3d1d201c-c2a5-4d0a-a2ff-6b19bb6e4b02)) | The three tabs "Tasks, Code reviews, Archive" as a model for one filter row. | The composer at the top of the list. The capture field stays global. |
| Asana, list beside the detail ([screen](https://mobbin.com/screens/15ea50b5-6ba1-47d3-99de-724335b1840c)) | The list keeps its groups when a detail opens beside it. | The detail opens as a third column on top of a full-width list. Our list narrows into the rail. |

### 1.3 What the code gives us today (survey of the worktree)

- `AlbatrossesSurface.tsx` groups `albatrossWorkV2.allWork` by `WORK_STATE_ORDER` with a serif
  header and a hint per group, filter pills, a "Show finished" toggle, the staleness
  `ReviewBatch`, and the `LaterShelf`. All of this stays. The row changes.
- `AlbatrossRow` (`primitives.tsx:174`) is title, `nextMoveLine`, area, and a `StateChip`. The
  chip goes: the status word on line 2 is the one indicator with the dot.
- `AppShell.PrimarySurface` renders `WorkThread` or `AlbatrossesSurface` by `selectedWorkId`
  (`AppShell.tsx:394-411`) for both the `albatrosses` and `areas` views. The rail is a new wrapper
  around `WorkThread` in both views.
- `WorkThread` already has the 50 px header (Back, title, plan line, Page, Details, More), the
  split with one trailing region, and `THREAD_SPLIT_QUERY = (min-width: 1024px)`.
- `ReadyForYou.tsx` already builds "In progress: {step}" plus the newest log line from
  `openHandoffs`; `workingLine` and `handoffLine` in `step-run-client.ts` are the preview-line
  helpers the rail reuses.
- `RUN_STATE_COPY` and `composerPlaceholder` in `lib/albatross/thread-view.ts` hold the words
  the row and the composer must match.
- The composer is `ChatComposer` inside `AssistantChat` (`AIBar.tsx:1335`), with `onStop={stop}`
  and a `thread` prop that already sets the placeholder.
- `motion/react` is in the tree (68 imports), so row regroup motion uses its `layout` prop and
  `useReducedMotion`. No new registry install is needed for the rail.
- The main sidebar is the shadcn `Sidebar` in `collapsible="icon"` mode, 16 rem open and 3 rem
  collapsed, controlled by `railOpen` in `lib/client-state.ts`.

## 2. Layout

### 2.1 Regions with a thread open (1440 × 900)

```
┌48┬───────────────────────────────────────────────────────────────────────────┐
│  │ Albatrosses        ⌘↑ ⌘↓ │ Back  Title        [Step 2 of 3 · In progress]  Page Details More │
│  │ All 8  Needs you 3  In progress 4 ├─────────────────────────────────────┬──┬────────────────┤
│  │ Needs you 3 ────────────── │ conversation column                 │se│ Page or Details│
│  │ ● Plan the Lisbon trip  3m │   plan block, run blocks, notes     │am│ (one trailing  │
│  │   Needs your answer · …    │   (max 660 px, centred)             │  │  region)       │
│  │ In progress 4 ──────────── │                                     │  │                │
│  │ ● Renew the car reg…  now  │ ┌ composer ───────────────────────┐ │  │                │
│  │   In progress · Typed …    │ │ To the run · Step 2   Stop and… │ │  │                │
│  │ Carried 1 ──────────────── │ └─────────────────────────────────┘ │  │                │
│  │ Finished · 5   Later · 2   │                                     │  │                │
└──┴────────────────────────────┴─────────────────────────────────────┴──┴────────────────┘
   main sidebar (icon)   rail 300        conversation (min 520)          region 440 (min 400)
```

The rail is the leading pane of the thread view. It has its own 50 px header, level with the
thread header, so the two titles sit on one baseline. The rail list scrolls on its own.

### 2.2 Widths and breakpoints

| Window | Main sidebar | Rail | Conversation | Trailing region |
|---|---|---|---|---|
| ≥ 1680 | As the user left it (open 256 or icon 48) | 300 px | Minimum 520 px | 44 %, minimum 400 px |
| 1280–1679 | Icon mode, 48 px, while a thread is open; restored on Back | 300 px | Minimum 520 px | 44 %, minimum 400 px |
| 1024–1279 | Icon mode | 272 px; hides while the region is open, returns when it closes | Minimum 480 px | 46 %, minimum 380 px |
| 768–1023 | Icon mode | None. Back shows the full list, as today | Full width | Sheet, 92 vw |
| < 768 | Hidden (mobile sidebar) | None | Full width | Full-screen sheets |

Check at 1280: 48 + 300 + 520 + 400 + 12 (gutters) = 1280. The rail is not resizable in v1.
It has no collapse control: Back closes the thread, and the size rules above hide the rail
where it cannot fit.

### 2.3 The main sidebar

Three wide columns of navigation feel heavy. Decision: while a thread is open and the window is
narrower than 1680 px, the shell sets the main sidebar to its icon mode (the existing
`collapsible="icon"` state) and remembers the user's `railOpen` value. Back restores it. The
user can still open the main sidebar by hand while a thread is open; then the rail stays, and
the conversation takes the loss. The rail is the only list of Albatrosses on screen: the main
sidebar's "Albatrosses" item stays a plain link with the "N need you" badge
(`railWorkBadge`), as today.

### 2.4 The page pane and the details panel

Unchanged from PR 1: one trailing region, the page displaces the details, auto-open only for a
run started from this view. With the rail, the region takes its share from the conversation,
never from the rail (the rail has a fixed width). The screenshot `rail-pane.png` shows the
three panes at 1440: the title gets an ellipsis, which is the PR 1 rule, and its tooltip shows
the full title.

### 2.5 The Areas view

`AppShell` renders `WorkThread` from the Areas view too. There the rail shows the same list with
the area preselected: the rail header reads "Albatrosses · Travel" and the filter row has the
area removed from "All". Back returns to the area home, as today.

## 3. The row

### 3.1 Anatomy

```
 ●  Plan the Lisbon trip                                     3m
    Needs your answer · Which dates work?                    (· Travel, list only)
```

- Column 1, 16 px: the status dot, 7 px, centred on the title's x-height.
- Column 2: line 1 is the title (13 px, one line, ellipsis) and, at its right, the time (11 px,
  tabular). Line 2 is the status word (12 px, medium, in the status voice), a middle dot, and the
  preview (12 px, muted, one line, ellipsis). The preview runs under the time, so the rail shows
  about 36 characters of it at 300 px.
- The full list adds the area name after the preview in the faint voice, and gives "needs you"
  rows the serif 16 px title that the current list already uses for prominence.
- A row that works, and a read row that does not need you, sits at 72 % opacity. Hover, focus,
  and "open" restore it. "Needs you" rows and the open thread never recede.
- The open thread has the `--color-selected-soft` fill and `aria-current="page"`.
- Hover: the `title` attribute carries the full preview line, so a cut line is one hover away.

### 3.2 The status word and the preview, every status in the contract

The server sends `status` and `statusLine`. The client maps `status` to the word and the voice;
`statusLine` is the preview. This table is what the client expects `statusLine` to hold.

| `status` | Status word | Voice, dot | `statusLine` (the preview) | Example |
|---|---|---|---|---|
| `needs_answer` | Needs your answer | waiting | The question's form title | "Which dates work?" |
| `your_turn` | Your turn | waiting | `next.detail` | "Confirm the 9:30 slot on the page" |
| `ready_for_you` | Ready for you | waiting | The first artifact's label, else the summary | "Draft to the court clerk" |
| `in_progress` | In progress | working, live | The newest log line; before the first line, the step title | "Typed your saved Driver's license on dmv.ny.gov" |
| `answering` | Reply in progress | working, live | The first 80 characters of the message it answers | "What did Sam ask for in the last email?" |
| `starts_soon` | Starts soon | working, still | "Starts when another run ends" | — |
| `done` | Done | done | The proof line, else the summary | "Due date moved to Oct 22" |
| `did_not_finish` | Did not finish | failed | The error line | "The site did not load after three tries" |
| `stopped` | Stopped, or Stopped by you | quiet, hollow | The reason: "At its time limit", "At its cost limit"; for a user stop, `nextMoveLine` | "Next: Call the county line, 555-0144" |
| `idle` | (no word) | hollow | `nextMoveLine` as today | "Next: Read both quotes side by side" |

"Reply in progress" is the proposed plain word for the contract's "Answering" (open question 1).
"Stopped by you" needs `stoppedBy` on the row (open question 2).

### 3.3 The indicator and its motion

- Shape: a 7 px filled circle. Full circles are reserved for status dots in the app, so the
  dot needs no new shape token. Idle rows get a hollow circle with a 1.5 px border.
- Voices: working `--color-accent`, waiting `--color-accent-3`, done `--color-success`, failed
  `--color-danger`, quiet `--color-text-faint`. These are the four `TONE_CLASS` voices of
  `RunBlock`, so the row and the block agree.
- Motion: a run in progress or a reply in progress gets one halo ring on the dot, 1.5 px, that
  fades from 35 % to 0 over 2.4 s and repeats. Eight such rows make eight slow halos, not eight
  shimmers. "Starts soon" is still. Under `prefers-reduced-motion`, the halo is a static ring at
  30 %.
- No shimmer on any text in the rail or in the list. The status word "In progress" is enough.

### 3.4 Unread

- Unread is the contract's `unread` (`lastActivityAt > seenAt` for a handoff, a question, a
  finished reply, a run that ends). Log lines never make a row unread.
- Unread rows: title weight 600, preview in the full text colour, time in the accent voice and
  weight 500. Read rows: title 400 or 500, preview muted, time faint. No second glyph.
- Unread beats every recede rule. A "Done" row that is unread shows at full strength; the same
  row, once read, recedes.
- Seen: the client posts `seen` for the open thread when the thread is on screen and the document
  is visible and focused, on open and after each new activity (debounced 1 s). A background tab
  never marks a thread seen. The open thread therefore never flashes unread while you read it.

### 3.5 Time

- Rows that work (`in_progress`, `answering`) show the run's elapsed time: "now" under 60 s,
  then "1m", "12m", "1h 4m". Other rows show time since `lastActivityAt`: "3m", "1h", "5h",
  "Yesterday", "Mon", "Oct 3", "Oct 3, 2025".
- Tabular numbers, 11 px, faint. The slot is 30–64 px wide and the preview runs under it.

### 3.6 Hover actions and the in-place flows (T10)

The actions appear on hover and on focus, in the time's slot, as 22 px text buttons. Nothing
else moves.

| `status` | Actions | What happens |
|---|---|---|
| `needs_answer` | Answer | Opens the question in place (below) |
| `your_turn` | Open | Opens the thread at the handoff. The page part needs the page |
| `ready_for_you` | The handoff's primary when it opens in place ("Read and send", "Open the document"), else Open | The same rule as the Brief's "Ready for you" (`readyForYouRows`) |
| `in_progress` | Steer, Stop | Steer opens a one-line note in place; Stop cancels the run |
| `answering` | Stop | Stops the reply on the server (T11) |
| `starts_soon` | Stop | Removes the queued run |
| `did_not_finish` | Try again | Starts the step again |
| `done`, `stopped`, `idle` | none | Click opens the thread |

Answer in place (`answer.png`): the row grows downward and shows the same `FormQuestionCard` the
thread uses, in compact density, on the paper inside the elevated card. Footer: "Open the
thread" (quiet, left), "Cancel", "Continue" (primary). Rules: one row open at a time; Escape
closes; a form with more than four fields, or with an `address` or `contact` field, opens the
thread instead; the list keeps its scroll position because the row grows below itself. After
"Continue" the row collapses and its line 2 reads "In progress · Continues with your answer"
until the run's first log line arrives.

Steer in place (`rail.png`, "Pay the water bill"): the row grows by one input (placeholder
"Tell the run what to change", single line, Enter sends, Escape closes, 2,000 characters) and
"Send". Under it: "Albatross reads this at its next step." After Send the preview reads "Sent to
the run" in the working voice for four seconds, then the newest log line returns. The note goes
through `POST /run { action: 'steer' }`, so the thread shows the same bubble and receipt (§5.2).

Stop from a row: no confirmation dialog. The row moves to "Carried" with "Stopped by you · Next:
…" and its hover action becomes "Handle it". A stopped run cannot continue from its page, so
there is no Undo.

### 3.7 Sort, grouping, and stability

- Order, from the contract: needs you, in progress, then `lastActivityAt` descending.
- Groups in the rail: "Needs you" (`needs_answer`, `your_turn`, `ready_for_you`,
  `did_not_finish`), "In progress" (`in_progress`, `answering`, `starts_soon`), "Carried"
  (everything else that is open). Each group header is 11.5 px faint text, a count, and a
  hairline. Empty groups do not render.
- The full list keeps its groups and hints, with these changes: "Needs you" gains
  `did_not_finish`; "In progress" means a run or a reply in motion, hint "Albatross works on these
  now."; the open Work with nothing in motion is "Carried", hint "Nothing is in motion. Albatross
  has the next step."; "Waiting", "Paused", "Later", and the finished groups are unchanged.
- The rail foot shows "Finished · N" and "Later · N" as quiet counts. Each is a link to the full
  list with that group shown. Dormant Work never appears in the rail.
- Stability: a row changes group at once. The order inside a group refreshes only while the
  pointer is outside the rail and no row has focus; a pending reorder waits up to 10 s after
  the pointer leaves, then applies. The open thread does not move while the rail is hovered.
  Group changes animate with `motion`'s `layout` prop over 200 ms; under reduced motion they jump.

### 3.8 The filter (T12)

Three text pills at the top of the rail: "All", "Needs you", "In progress", each with a quiet
count. The rail's filter and the full list's filter are one store value (`albatrossListFilter`),
so Back shows what the rail showed. "No area yet" and the area pills stay on the full list
only. Search comes later, as the brief says.

### 3.9 Empty states

| Where | Copy |
|---|---|
| Rail, All, no rows | "Nothing on your shoulders yet." and the button "Get this off my mind" |
| Rail, Needs you | "Nothing needs you." then "Albatross asks here when it cannot go further." |
| Rail, In progress | "No run is in progress." then "Press Handle it in a thread to start one." |
| Full list | The current `EmptyState` copy, plus the In progress variant above |

## 4. Hopping (T3)

- Click a row: `setSelectedWorkId(workId)`. The thread mounts with `key={workId}`, as today.
- ⌘↑ / ⌘↓: previous / next row in the rail's visible order (filter applied, groups flattened),
  no wrap at the ends, when focus is not in a text field. ⌥⌘↑ / ⌥⌘↓: the same, everywhere,
  including the composer, because ⌘↑ in a text field moves the caret to the start of the text
  (open question 3). The rail header shows "⌘↑ ⌘↓" as a quiet hint.
- Focus stays where it was. A hop from the composer keeps focus in the new thread's composer. A
  hop from a rail row keeps focus on the new row. The new thread's title is announced (§7).
- Drafts: the composer text is kept per thread in the client store and in localStorage under
  `lab86-thread-draft:<workId>`. It is restored on return and cleared on send. A row with an
  unsent draft shows the word "Draft" in the accent-2 voice in its time slot, except on the
  open row.
- Scroll: the thread keeps `{ scrollTop, follow }` per thread for the session. If the thread
  followed the bottom when you left, it follows the bottom on return. Otherwise it restores
  `scrollTop` and shows the "Newest" pill (PR 1 decision 12) if newer items exist below.
- Below 1024 px there is no rail; ⌘↑ / ⌘↓ still hop through the same order.

## 5. Steering in the thread (T7, T8, T9, T5, T11)

### 5.1 The composer by thread state

| Thread state | Route line (above the field) | Placeholder | Right control |
|---|---|---|---|
| A run in progress, or queued | "To the run · Step 2, Renew online" | "Tell the run what to change" | "Stop and redirect" |
| Redirect mode (after the press) | "Stop and redirect · The run stops when you send" | "What should Albatross do instead?" | "Cancel" (returns to the run route) |
| Needs an answer | none | "Answer here, or tell Albatross what to change" | none |
| Reply in progress | none | "Tell Albatross what to do" | "Stop" (the existing composer Stop, now also the server stop) |
| Otherwise | none | the PR 1 placeholders | none |

While a run works, every message goes to the run (owner decision 2). The route line names the
run so this is never a surprise. A quiet "Ask instead" link at the end of the route line sends
one message to the chat instead; the line then reads "To Albatross · The run keeps going" with
"To the run" to switch back (open question 4).

### 5.2 Receipts under a sent note

The note is a normal user bubble. One line under it, right-aligned, 11.5 px, carries the receipt.
This reverses PR 1 decision 8 ("no extra sent-to-the-run line"), because the brief now asks for
the receipt.

| Note state | Line | Voice | Action |
|---|---|---|---|
| Sent, not read yet | "Sent to the run" | faint | none |
| Read (`readAt` set) | "Read by Albatross · 10:40" | muted | none |
| Not read, the run ended, the next run of the step gets it first | "Not read: the run ended first. The next run reads it first." | muted | none |
| Not read, no run continues | "Not read: the run ended first" | warning | "Send again" |
| Sent with "Stop and redirect" | "Stopped the run. Started a new run with this note." | muted | none; the new run block follows |
| The send failed | "Not sent" | danger | "Send again" |

"Send again" calls `albatross_handle_step` with the note: it resumes the newest handoff of the
step, or starts a run, and the bubble's receipt returns to "Sent to the run". The run log line
"Read your note: …" stays as in PR 1.

### 5.3 Stop and redirect (T8)

1. The user presses "Stop and redirect" on the route line. The composer enters redirect mode
   (table above). The run block does not change yet.
2. The user types "Go back and choose the Saturday session" and sends.
3. The client posts `{ action: 'redirect', runId, note }`. The old block ends with "Stopped by
   you". A new block, "Continued", starts under it with the note as its first log line
   ("Read your note: Go back and choose the Saturday session"). The bubble shows the redirect
   receipt.
4. Escape, or "Cancel", leaves redirect mode with the text kept in the field.

A plain "Stop" stays on the run block (PR 1). "Stop and redirect" lives on the composer because
it changes what the next message does.

### 5.4 A reply that keeps going (T5) and Stop (T11)

- Leaving the thread no longer aborts the reply (the server contract). The thread subscribes to
  the session; while `answering` is true it shows a quiet placeholder bubble "Reply in progress"
  with the registry `ShimmerText` and "Stop". When the saved message arrives, it replaces the
  placeholder. Rejoining the live stream mid-reply is a later improvement (open question 6).
- The composer Stop calls `POST /api/agent/stop { sessionId }` and then aborts the local stream.
  The row's status changes within one query tick.
- The rail row shows "Reply in progress · {the message}" meanwhile, then the unread mark when the
  reply is saved.

## 6. The stories as screen states

Copy is sentence case, STE, no "AI", "assistant", or "agent".

**T1. A live list.** Back shows the full list (`list.png`). Each row: dot, title, time, status
word, preview. "Needs you" first, "In progress" second, "Carried" by last activity. The rows
update without a reload (`albatrossThreads.list` is live on web).

**T2. Unread.** "Return the library books" finished while the user was elsewhere: title 600,
"Done · Due date moved to Oct 22" in full text colour, "1h" in the accent voice. Opening it
posts `seen`; the row relaxes to regular weight on the next tick, not before the user looks.

**T3. Hop.** In a window 1024 px or wider, the rail stays beside the thread (`rail.png`). The
open row is filled and marked `aria-current`. ⌘↓ from "Renew the car registration" opens "Pay
the water bill"; the composer text typed in the first thread is still there on ⌘↑.

**T4. Hop (I).** Not web. The same contract and the same copy.

**T5. Threads keep working.** The user asks "What did Sam ask for in the last email?" in "Reply
to Sam Rivera about the lease" and hops away. The row reads "Reply in progress · What did Sam
ask for in the last email?" with the halo. When the reply is saved, the row reads "Done · …" or
the idle line, in unread weight. Back in the thread, the reply is there.

**T6. Several runs at once.** Four rows in "In progress", four halos. An eleventh run shows
"Starts soon · Starts when another run ends" with a still dot, and the plan line in its thread
reads "Step 1 of 2 · Starts soon".

**T7. Steer directly.** In `rail.png` the composer reads "To the run · Step 2, Renew online". The
user sent "Use the two-year option". The bubble shows "Read by Albatross · 10:40". The run log
has "10:40 Read your note: Use the two-year option".

**T8. Stop and redirect.** §5.3. The old block ends "Stopped by you"; the new block starts
"Continued" with the note in its log; the bubble reads "Stopped the run. Started a new run with
this note."

**T9. A note that came too late.** The run ended before it read the note. The receipt reads
"Not read: the run ended first. The next run reads it first." when the step has a handoff that
can continue, else "Not read: the run ended first" with "Send again".

**T10. Answer and steer from the list.** `answer.png`: "Answer" on "Plan the Lisbon trip" opens
"Which dates work?" in place with the three options, the recommended tag, and "Continue".
`rail.png`: "Steer" on "Pay the water bill" opens the one-line note with "Send". `list.png`:
the hover state shows "Steer" and "Stop" in the time's slot.

**T11. Stop a reply.** The composer Stop ends the reply on the server. The row changes within one
tick. A Stop on the row does the same without opening the thread.

**T12. Find a thread.** The three pills at the top of the rail: "All 8", "Needs you 3",
"In progress 4". The counts are live. The choice is shared with the full list.

### 6.1 State matrix, the row

| `status` | Dot | Halo | Weight (unread / read) | Recede when read | Hover actions |
|---|---|---|---|---|---|
| `needs_answer` | waiting | no | 600 / 500 | no | Answer |
| `your_turn` | waiting | no | 600 / 500 | no | Open |
| `ready_for_you` | waiting | no | 600 / 500 | no | primary or Open |
| `did_not_finish` | failed | no | 600 / 500 | no | Try again |
| `in_progress` | working | yes | 600 / 400 | yes, 72 % | Steer, Stop |
| `answering` | working | yes | 600 / 400 | yes, 72 % | Stop |
| `starts_soon` | working | no | 600 / 400 | yes, 72 % | Stop |
| `done` | done | no | 600 / 400 | yes, 72 % | none |
| `stopped` | hollow | no | 600 / 400 | yes, 72 % | Handle it |
| `idle` | hollow | no | 400 | yes, 72 % | none |
| open thread, any status | as above | as above | 500 | never | none shown |

### 6.2 State matrix, a sent note

See §5.2. Transitions: sent → read; sent → not read (carried) → read (by the next run); sent →
not read (no run) → sent (after "Send again"); redirect → its own receipt; failed → sent (after
"Send again").

## 7. Accessibility, dark mode, reduced motion

- The rail is a `nav` landmark named "Albatrosses". The list is `ul role="list"` with one
  `li` per row. Each row is a `button` with `aria-current="page"` on the open thread and an
  accessible name "{title}, {status word}, {preview}, {time}". Unread rows add ", unread" to the
  name.
- Keyboard in the rail: one tab stop for the list (roving tabindex). ↑ / ↓ move between rows,
  Home / End jump, Enter or Space opens, → moves into the focused row's actions and ← returns,
  Escape closes an in-place form or note. The filter pills are a `group` of toggle buttons with
  `aria-pressed`.
- Live region policy: one `aria-live="polite"` region for the whole rail. It announces only a
  row that enters "Needs you", a finished reply, and a finished run, merged and throttled to one
  message every 5 s: "Two Albatrosses need you: Plan the Lisbon trip, Book the dentist
  appointment." Log line changes and reorders never announce. Events of the open thread are
  announced by the thread's own run block region (PR 1), so the rail skips them.
- A hop announces the new thread's title and plan line through the thread header's `h1`
  (`aria-live="polite"` on the header, one line).
- In-place forms are `section`s named by the question title; the one-line note is a labelled
  input "Note to the run".
- Dark mode: every colour is a token. The status voices use the dark values of `--color-accent`,
  `--color-accent-3`, `--color-success`, and `--color-danger` from `globals.css`. Recede is opacity,
  so it works in both modes (`rail-dark.png`).
- Reduced motion: no halo (a static ring), no layout animation on regroup, no height animation
  on in-place rows, receipts change without a fade. The thread keeps PR 1's rules.

## 8. The mockup

- Source: `/tmp/albatross-threads-mockup/index.html`, one file, switched by `?screen=rail`,
  `?screen=rail&pane=1`, `?screen=list`, `?screen=answer`, and `&dark=1`. Tokens are copied from
  `app/globals.css` (light defaults and the `:root.dark` block, accent hue 156, depth 1, tint 0).
  Fonts are the repo's Geist and Fraunces files.
- Renderer: `/tmp/albatross-threads-mockup/shoot.mjs` with the worktree's `playwright-core`
  1.62.1 and Chromium 151. 1440 × 900 at 2×.
- Three iterations: (1) rows nested buttons inside buttons, so the hover actions and the in-place
  buttons fell out of the row; rows became `div[role=button]`. (2) "Did not finish" sat in
  "Recent" in the rail and in "Needs you" in the list; it needs a decision, so it is "Needs you" in
  both, and the group vocabulary became one (Needs you, In progress, Carried). (3) The time cell
  spanned both lines and cut the preview early; the time now sits on line 1 and the preview runs
  under it. The thread gained the done block for step 1 so its history reads as real, and the page
  pane went from 474 to 440 px so the title keeps more room.

## 9. Open questions for the lead designer

1. **"Answering" versus "Reply in progress".** The brief allows a plain word. Recommendation:
   "Reply in progress". It is parallel to "In progress", has no -ing verb, and says what moves.
   Alternative: "Writes a reply", which reads oddly in a list.
2. **`stoppedBy` on the row.** The contract has one `stopped` status, but the thread shows
   "Stopped" and "Stopped by you". Recommendation: add `stoppedBy: 'time' | 'cost' | 'user' |
   null` to the row, so the list and the block say the same thing.
3. **⌘↑ / ⌘↓ in the composer.** In a text field these keys move the caret to the start or the end.
   Recommendation: ⌘↑ / ⌘↓ outside text fields, ⌥⌘↑ / ⌥⌘↓ everywhere. Do not add T3 Code's
   ⌘⇧[ / ⌘⇧] as a third pair.
4. **"Ask instead" while a run works.** Owner decision 2 routes messages to the run. A user who
   wants an answer from the chat needs a way out. Recommendation: keep the quiet "Ask instead"
   link on the route line; the default stays the run.
5. **Hover actions on touch and keyboard.** Recommendation: the actions show on focus-within
   and on hover; on a touch laptop they show on the first tap of the time slot. No swipe.
6. **Rejoin a reply mid-stream.** The contract saves the finished reply. Recommendation: ship
   the placeholder bubble now; add a resumable stream (`GET /api/agent/stream?sessionId`) later.
7. **"Mark unread".** T3 Code has it in the context menu. Recommendation: not in v1. The
   receipt and "Needs you" cover the cases we know.
8. **Rail width and resize.** Recommendation: fixed 300 px (272 px on laptops), no handle. One
   seam less to drag, and the conversation column keeps its 660 px measure.
9. **The main sidebar at ≥ 1680 px.** Recommendation: leave it as the user set it. At that width
   256 + 300 + 660 + 440 still fits.
10. **Group name "Carried".** The Work that is open with nothing in motion needs a name that is
    not "In progress". Recommendation: "Carried", with the hint "Nothing is in motion. Albatross
    has the next step." It matches "Albatross is carrying this" and "Kept, not carried".
11. **Receipt line versus PR 1 decision 8.** Decision 8 said no "sent to the run" line.
    Recommendation: reverse it, as the brief's T7 and T9 require the receipts; keep the line to
    11.5 px under the bubble so the bubble still reads as a normal message.
12. **Stop from a row without confirmation.** Recommendation: no dialog. The row's "Handle it"
    is the recovery, and a dialog on every Stop makes the list slower than the thread.
13. **The live region vocabulary.** Recommendation: three event kinds only (needs you, reply
    finished, run finished), merged every 5 s. Anything more floods a reader with eight runs.
14. **Elapsed time on rows at work.** Recommendation: elapsed time ("12m") on `in_progress` and
    `answering` rows, time since activity on the rest; otherwise a 20-minute run reads as stale.
