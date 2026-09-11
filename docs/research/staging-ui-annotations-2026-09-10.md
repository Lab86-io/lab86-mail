# Staging UI review

Web implementation of the September 10 review and its local-preview follow-up.
The user has asked to review locally before pushing; staging remains unchanged.

Latest corner choice: the user requested one further undo after the percentage
radius rollback. All shared surfaces now use fixed 14px / `superellipse(1.475)`
corners (9.5px round fallback). Long edges are straight again. The console fix
and other sessions' changes remain intact.

September 11 final rollback: the user requested the exact corners from before
the subagent research, restored from the saved edit history: shared 50% / capped
14px radii and `superellipse(1.65)`, with 9.5px round fallback. The later role
ladder and softening experiment below are historical. Removed the obsolete
Pierre theme registration workaround, which duplicated the library's built-in
themes during initial load and hot reload. Focused tests pass, and actual code
diff rendering in both themes produces no console errors. Other sessions'
frame and application changes are preserved.

## Research and direction

Inspected the supplied screenshots, the live staging page, the shared local
preview, and the surrounding sidebar, Mail, reader, assistant, Today, and
calendar implementations. The initial session had no Mobbin screen/flow tools;
the later Claude corner review successfully used Mobbin and is linked below.
The initial web searches covered sidebar notification
and collapse controls, calendar toolbars in narrow panes, daily brief ledes,
and split assistant workspaces. See the previous
[notification research](notifications-workspace-2026-09-10.md).

Reviewed [Linear Inbox](https://linear.app/docs/inbox) for a stable sidebar entry
into one notification workspace. The existing bell retains its feed/count and
navigation behavior. It is now left of collapse, with equal 32px control boxes
and centered glyphs; collapsed navigation stacks expand first, then the bell.

The requested animation research covered
[Chamaac Dancing Letters](https://www.chamaac.com/components/text-animations/dancing-letters),
[Chamaac Text Loop](https://www.chamaac.com/components/text-animations/text-loop),
their public registry source, and
[shadcn.io Rotating Text](https://www.shadcn.io/text/rotating-text).
Dancing Letters animates individual characters in response to hover/click;
Text Loop sequences changing phrases. The implementation uses an original,
controlled letter-roll component informed by those patterns, with the existing
Motion dependency. It omits the demos' large type, gradient, cursor and dramatic
bounces. Text is 12.5px, regular-weight, and upright. A measuring grid prevents
width changes. Hover/focus, hidden-document and reduced-motion protections stay
in place; the accessible name never cycles.

Claude Fable 5.1 replaced the rejected whole-width elliptical experiment with
one continuous curve, softened from 1.7 to `superellipse(1.6)` on final user review,
and fixed pixel sizes: 10px controls,
14px cards, 16px overlays and 20px panels (smaller round fallbacks). See
[the corner-system research](albatross-corner-system-2026-09-10.md) for the
final geometry, primary references and Browserbase/Mobbin access notes.
`rounded-ui` remains the shared entry point for controls, with semantic panel
card and overlay roles. The common class merger registers `ui` as a radius so
component overrides retain normal precedence. Button, sidebar Search, prompt
field, Ask/Hold composer and suggestions use the shared abstraction. Circular
avatars/status dots and square interior joins retain their intended geometry.

Reviewed [Adobe dropcap.js](https://github.com/adobe-webplatform/dropcap.js),
its [typographic demo](https://adobe-webplatform.github.io/dropcap.js/), and
[MDN initial-letter](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/initial-letter).
Added the dependency-free Apache-2.0 package `dropcap.js@1.0.1` behind a reusable
React DropCap. Adobe measures the loaded font's cap height and baseline for a
two-line initial. Browser inspection found that CSS support detection alone
did not produce the enlarged inline initial, so the actual library performs
the layout. It reruns on font loading and paragraph resize, and keeps quotes,
combining marks, and the complete prose in reading order.

Reviewed [Google Drive filtering](https://support.google.com/drive/answer/2375114?hl=en)
and [FullCalendar toolbar groups](https://fullcalendar.io/docs/headerToolbar).
The applied direction groups location/search/filter controls above the files,
and keeps calendar date navigation, view choice, and creation in stable groups.
At narrow pane widths the calendar uses a labeled view menu rather than five
shrinking icon tabs. Mobbin remained unavailable for this follow-up.

Reviewed [Notion Agent](https://www.notion.com/en-gb/help/notion-agent) for a
single assistant working with current page context. Also reviewed its
[sidebar navigation](https://www.notion.com/help/navigate-with-the-sidebar)
for the distinction between choosing a page and explicitly opening a side peek. The adaptation keeps the
existing conversation owner and passes an explicit file pointer rather than
creating a second document-specific chat. Mobbin tools remained unavailable.

The review server now uses [Bun's HTML development server](https://bun.com/docs/bundler/fullstack)
and [React hot reloading](https://bun.com/docs/bundler/hot-reloading). Component
updates preserve the mounted app, chat draft and split presentation. Tailwind
updates are rebuilt on source changes and swapped through a stylesheet event
stream. Synthetic adapters remain isolated to the preview bundler.

## Final behavior

- One persistent outer frame belongs to the shell, around every sidebar page
  and the assistant. Its margin is 6px. Mail and its reader no longer paint
  separate nested frames. Mail-reader and assistant dividers run the full
  interior height, with square internal edges. The rail resize target overlays
  the boundary, so dragging remains available without adding a 6px gutter.
- Sidebar Chat opens full-screen. Choosing another page closes that view without
  discarding the conversation; navigation never creates a split. An explicitly
  opened split remains across page changes when both panes fit. The floating
  launcher opens corner chat, or split chat while editing a file, with direct full-screen and split controls.
  The page and conversation keep their DOM owners, draft, attachments, scroll
  and streaming state across those presentation changes.
- Mail date groups use the inbox background in both themes. Its search field
  wrapper now uses the adjacent neutral buttons' fill.
- The calendar responds to its own pane width, not the viewport. The entire
  toolbar is unboxed, with ghost secondary actions. Date arrows sit directly beside
  the date. Navigation and Add stay on the first row, with views beneath in narrow
  panes. Named calendar controls use the full row below, with a check/spinner
  sync control at the trailing edge and detailed status/retry in its tooltip.
  Below 600px views become one labeled menu, with tabs above that width; at
  960px all groups fit one row. Zoom lives in the display-options menu.
  Sync status stays available. Full date ranges
  remain available as titles when truncated. Weekday labels stack above their
  dates in narrow panes, and the week grid remains available on phones.
- Today has a distinct opening lede and smaller supporting paragraphs, retaining
  all narrative prose, with a large two-line initial. The museum artwork sits
  flush inside the shared custom frame. The artwork inset is now 12px. Per the final clarification, the narrative
  retains its previous 24px reading inset, paragraph spacing, and indents.
  The edition title is independently centered in the artwork. Weather sits beneath it
  as an unboxed, centered line at wider widths, wrapping within phone widths, including location,
  current temperature/condition, high/low, and daily precipitation probability.
  The former standalone weather column is removed. Supporting paragraphs have 1.5em first-line
  indents; the drop-cap lede keeps its opening alignment. Today and Files use the same
  opaque content background as Mail in both themes.
- Files replaces its second sidebar with a compact location menu that preserves
  drive selection, attention states, and Add a drive. Search follows pane width,
  and folder breadcrumbs remain available when inside a folder. The local
  fixture includes three searchable sample documents that open in the real editor.
  Search and adjacent controls share a 32px height; the tagline and editor title
  icon are removed. Editor toolbar/canvas surroundings use the same content fill.
- Document conversations use the global assistant, keeping the same draft,
  attachments and history. File pointers are transient and attached at send time;
  unsaved edits are disclosed, and queries refresh after document tools finish.
  Existing revision/undo checks remain in a compact inline suggestion review.
  Google files use read/propose tools for the original file, without creating a
  copy; proposals require an unchanged provider revision and an explicit Apply.
- The empty chat heading carries the exact clicked invitation plus the signed-in
  user’s first name (Alex in the synthetic preview). Keyboard opening uses that
  same visible invitation. The generic explanatory paragraph is removed. Its
  header has an inset custom frame with a faint border instead of a full-width
  bottom rule. The invitation is transient and does not enter persisted state.
- Every launcher destination has several contextual invitations, including
  document, spreadsheet and presentation editor phrases. Today’s compact header weather uses actual forecast values and units, with
  precipitation probability and a provider attribution link. Missing precipitation
  is shown as unavailable rather than zero. The existing standalone Tool UI weather
  renderer remains available for other uses. Generated work cards
  use shared Card, Button, Textarea and Badge primitives while retaining trust
  labels, navigation and correction/completion behavior.
- Respond & act hands a user instruction from a Today recommendation to the
  shared agent. The server rechecks current owned SBAR sources and live Work.
  Queuing waits for an existing stream; composer text and files remain untouched.
  A scoped conversation is saved before the distinct brief handoff opens globally.
  Existing Work shape and completion rules are respected. The calendar tool can
  create real Google Meet links when authorized, without inventing pending links.
  See [the execution record](today-actionable-work-2026-09-10.md) for implemented
  scope and remaining artifact-card/background execution work.
- The local fixture supplies a complete fictional
  edition through the actual Today API responses, including valid working cards,
  sample weather, calendar events, and readable sample messages. Respond & act
  also completes with illustrative inline draft and proposal cards. The proposal
  opens the existing sample document in the real editor; these are synthetic
  transports, not live model or provider mutations.

## Reproduction and acceptance

Run `ALBATROSS_PREVIEW_HOST=0.0.0.0 bun scripts/preview-app-workspace.mjs`.
For this review it is running independently as the user service
`albatross-local-preview.service`, with restart-on-failure and output in
`/tmp/albatross-local-review.log`. `systemctl --user restart albatross-local-preview`
restarts this local preview only. This prevents tool-turn interruptions from
closing an otherwise live dev server.
The shared browser can reach `http://100.104.121.93:18847/?view=today` through
Tailscale. Its localhost is a different machine. The default fixture renders
the actual AppShell; `?review=controls` isolates calendar and brief typography.
All transport is synthetic; account/backend writes are not performed.

Full suite for this work: **3,577 passed**, zero failures across 368 files.
The integrated production build (including TypeScript) and repository lint passed.
The final curve-only softening is checked in the actual browser and uses the
same radius ladder. Picture-frame work arrived concurrently and is intentionally
preserved; the earlier artwork/text-inset measurements below predate that work.
Browser checks cover
390/768/1440px in light/dark, geometry/fill/corner parity, narrow calendar menus,
frame ownership and gutters, assistant draft/attachment/stream retention,
file navigation, and contextual document chat. Hot-reload verification changed
an actual calendar component and confirmed the existing page, split layout and
chat draft survived. A stylesheet change appeared in the shared browser without
manual refresh. No staging push has been made.

Actual-app browser acceptance passed at `/tmp/albatross-app-workspace-buRDVv`.
Follow-up browser acceptance passed at `/tmp/albatross-review-followup-KNuSlu`.
They cover calendar sync/retry, responsive navigation, preserved paragraph
insets, file/editor fill and height, intentional chat splits, context-aware
invitations and editor ownership. The new response flow passed at
`/tmp/albatross-brief-response-LoxnOl`: independent masthead centering, unboxed
weather, 6px page margins, queued response after a scoped stream, saved prior
conversation, preserved draft/attachment, changed-recommendation guard, and
sample inline draft/proposal navigation without sending.
Hot-update evidence is in `/tmp/albatross-round7-hmr.log`; a real component update
kept the page sentinel, chat text and split presentation.

Shape-specific artifact bodies, metric charts and unattended preparation remain
proposed in [today-actionable-work-2026-09-10.md](today-actionable-work-2026-09-10.md).
The user-directed response path described there is now implemented.

Final shared-checkout note: the user confirmed another session owns the new
decorative picture frames. Those changes and assets were preserved; the local
preview now serves their `/frames/*.png` assets. The combined masthead check
currently stops at title centering at 320px after that session's frame change.
That is a frame-layout follow-up, not a passed assertion. The response test's
optional `BRIEF_RESPONSE_ONLY=1` mode checks the queue, history, artifacts and
editor navigation independently while that visual work continues. Default
acceptance retains all masthead checks. Corner and control acceptance passed
after the final 1.6 softening; the previous 1.7 value is recorded for reversal.
The isolated agent handoff passed at `/tmp/albatross-brief-response-JMVChd`.
