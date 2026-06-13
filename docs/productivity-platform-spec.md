# Productivity Platform — Decision Record & Roadmap

Date: 2026-06-12. Decisions locked with Jakob via interview; this document is the
source of truth for the calendar / kanban / proactive-AI expansion. Update it when
a decision changes — don't let it drift.

## Vision

lab86-mail grows from an email client into an AI-powered productivity app:
**Mail + Calendar + Tasks**, each fully controllable by the AI agent. The bar:
"AI, find the ten things I have to do today, file them on the board, and put my
meetings, concerts, and hotel bookings on my calendar" — and it just happens.

## Locked decisions

### Calendar
- **Data:** Two-way sync via the existing Nylas v3 grants (same `grantId`s as mail).
  Events from every connected account sync into Convex (mirroring the mail-corpus
  pattern: backfill + webhook delta). Edits and AI-created events write back to the
  real Google/iCloud/Outlook calendars. The phone's calendar app and this app must
  agree.
- **Depth (all v1):** month/week/day views, all accounts merged with per-calendar
  colors, click-to-create, drag to move/resize; **recurring events** with proper
  this/this-and-following/all semantics; **attendees, invites & RSVP** (always
  confirm before anything emails another human); **free-busy / find-a-time** as
  AI tools.
- **UI engine:** Jakob's constraint: no heavy CSS overrides on a foreign DOM. Either
  a shadcn-registry calendar (vendored code we own) or a light headless engine with
  our shadcn/Tailwind components on top. Decision delegated to Claude with written
  justification — see "Calendar engine evaluation" below.

### Kanban / Tasks
- **Data:** Convex-native, no external task system. Schema owned by us.
- **Feature target** (functional port of sse-jakoblangtry-com, redesigned from
  scratch — analyze, never copy code): multiple boards; ordered columns; cards with
  title, markdown description (GFM task lists), labels (board-scoped, colored),
  priority, weight, due date, attachments, comments, per-card activity log;
  drag-and-drop for cards and columns; search/filter.
- **Sharing (both):** invite other app users to a board by email with member/viewer
  roles, **and** tokenized read-only public links. Collaborators see the board only —
  never mail or calendar. Convex live queries give real-time multiplayer once the
  permission layer exists. Permission model touches every board query: design it
  first, not as a retrofit.
- **UI base:** kibo-ui's shadcn-registry Kanban component (composable, dnd-kit,
  vendored into the repo) as the starting skeleton, redesigned to the app's
  editorial identity.
- Ordering scheme: the old app used integer order + array splice with transaction
  retry. With Convex + multiplayer, prefer fractional/lexicographic ordering keys to
  avoid full-column rewrites on every move.

### AI control
- **Surface:** the existing AIBar agent (Vercel AI SDK v6, `lib/ai/loop.ts`,
  `/api/agent`) becomes global across all three pages. New calendar/task tools join
  the existing registry (`lib/tools/`); `lib/tools/calendar.ts` stubs get wired for
  real. Full CRUD on boards/cards/events via tools.
- **Trust model: act + show diff, undoable.** The agent executes immediately, then
  presents a reviewable change-set ("created 4 events, 10 tasks") with per-item
  undo. Irreversible or outward-facing actions (sending invites to attendees,
  deletions that can't be restored) confirm first. Implies an **operation-log /
  undo framework** — every AI mutation records its inverse. `auditEvents` is the
  seed of this.
- **Proactive agent (full):**
  - Webhook-time: new mail can yield suggestions (task drafts, detected events —
    hotel confirmations, tickets, meetings).
  - Scheduled morning sweep: drafts the day's tasks, flags conflicts, composes the
    Today agenda.
  - **Delivery — suggestion queue:** proposals accumulate in an in-app review tray
    (badge on the Rail): accept / edit / dismiss. Nothing touches real calendars or
    boards until accepted; accepted items run through the normal undoable-diff path.
  - Inline suggestion chips on email threads ("Add to calendar", "Make a task"),
    one-click, nothing created until clicked.

### Cross-surface integration (all v1, but automations may trail)
- **Provenance everywhere:** AI-created tasks/events record their source (thread,
  chat command). Cards/events show a "from this email" chip deep-linking to the
  thread; threads show their linked tasks/events.
- **Tasks on calendar:** cards with due dates render on the calendar, visually
  distinct, draggable to reschedule.
- **Unified "Today" agenda:** a lightweight fourth surface — today's events + due
  tasks + needs-reply mail — the existing DailyReport grown into an interactive
  editorial home page.
- **Smart automations** (may defer within the milestone): reply-to-linked-email
  offers to complete its task; declined event offers to delete its prep task.

### Platform & rollout
- **Mobile:** desktop-first, mobile usable — responsive layouts with tap-based
  editing (card sheet, event form). Touch drag-and-drop is an explicit fast-follow,
  not v1.
- **Visual bar:** new surfaces must match the existing editorial identity (OKLCH
  theming, Fraunces, grain, shadcn primitives). No foreign-looking panes.
- **Sequencing:** **Calendar → Kanban → Proactive**, shipped as PR trains through
  the existing staging → PR → main → Railway pipeline. AI tools ship inside each
  milestone, not at the end.

## Milestones

1. **M0 — Foundations:** top-level navigation (Mail / Calendar / Tasks / Today in
   the Rail), page shell routing, AI operation-log + undoable-diff framework,
   suggestion-queue schema (empty tray UI can ship dark).
2. **M1 — Calendar:** Nylas calendar/event sync into Convex (backfill + webhooks),
   calendar UI (engine per evaluation), full editing incl. recurrence and RSVP,
   AI calendar tools (create/edit/move/delete/free-busy/find-a-time).
3. **M2 — Kanban:** board/column/card schema with membership + public-link
   permissions, board UI on kibo-ui base, card sheet with full metadata, AI task
   tools, provenance links, tasks-on-calendar.
4. **M3 — Proactive:** suggestion pipeline (webhook-time detectors + morning
   sweep), review tray, inline email chips, Today agenda page, smart automations.

## Calendar engine evaluation

**Verdict (2026-06-12): vendor `yassir-jeraidi/full-calendar` via its shadcn
registry** (`npx shadcn add https://calendar.jeraidi.dev/r/full-calendar.json`),
the maintained modernization of lramos33/big-calendar.

Why it wins (only candidate meeting every hard constraint):
- Exact stack match: Next 16 / React 19 / Tailwind 4 / shadcn/ui / Motion /
  date-fns 4. MIT, actively pushed (2026-04).
- Day / week / month / year / agenda views; drag-move across days/slots plus
  edge-resize in day/week, with its own draggable/droppable/resizable components
  (no extra dnd dependency).
- 100% code ownership: installs as shadcn primitives + Tailwind classes into our
  tree, so OKLCH variables and fonts apply with zero CSS overrides.
- Per-event color coding built in — remap to per-calendar colors.

Known gap: **no recurrence support in the component.** Resolved at the data
layer without the `rrule` package: Nylas `expand_recurring=true` returns
pre-expanded instances inside the sync window (-92d..+366d, sliding via lazy
resync kicks), each carrying `masterEventId`. The display layer renders
instances and never knows about recurrence. Edit semantics live in the
mutation layer: an instance id edits that occurrence, the master id edits the
series; "this and following" requires a series split and is deferred.

Cherry-pick visual polish from `origin-space/event-calendar` (event chips, agenda
styling) — it's prettier but self-declared alpha with drag limitations.

**Fallback:** FullCalendar v7 via its official shadcn registry (theme flavors
inherit shadcn CSS variables; built-in rrule plugin) if owned-code drag math
proves too fragile on multi-day/timezone edge cases. v7 is still RC — wait for
stable. Ruled out: Schedule-X (v4 paywalled drag/resize/drag-create),
react-big-calendar (CSS-override theming on foreign DOM, no recurrence),
lramos33 original (frozen on React 18/TW3 — superseded by the chosen fork).

## Open questions (decide during build, low stakes)

- Public-link tokens: per-board rotating token, revocable. Exact URL shape TBD.
- Viewer-role granularity on shared boards (member vs viewer confirmed; finer roles
  like per-card assignment permissions can wait).
- ~~Whether existing grants expose calendar scope~~ **Verified 2026-06-12: they
  don't.** Google grants have only `gmail.modify`+identity; Microsoft has only
  `Mail.ReadWrite`/`Mail.Send`; connector defaults match (mail-only). iCloud is
  scope-less (app-password connector) and may support calendar without re-auth.
  To enable calendar writes, Jakob must: (1) add
  `https://www.googleapis.com/auth/calendar` to the Google connector + the Google
  Cloud OAuth consent screen (sensitive scope — touches CASA verification), (2) add
  `Calendars.ReadWrite` to the Microsoft connector + Azure app registration, then
  (3) re-connect the accounts. The app's connect flow must request the new scopes.
  Build proceeds without them; sync degrades gracefully until re-auth.
- Suggestion-queue retention/expiry policy.
