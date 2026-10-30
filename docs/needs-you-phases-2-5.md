# Needs you, phases 1.1 to 5: build plan

Design: `docs/needs-you.md`. Phase 1 plan and server notes:
`docs/needs-you-phase-1.md`. Shared contract: `lib/obligations/contract.ts`
(additive changes only; note each change in your report). Owner order
(2026-10-30): build all phases today. Everything stays behind
`LAB86_NEEDS_YOU`; users outside the flag see no change.

## What production showed after phase 1 (2026-10-30)

The 30-day fill for the owner made 31 items: 28 `change`, 2 `action`, 1
`reply`. Most changes need nothing from the user: terms and privacy updates,
renewal notices, security alerts that are already done. 15 were
`time_sensitive`, so they filled Now. Phase 1.1 fixes this first.

## Builders and the files they own

A builder edits only the files it owns. A builder that needs a change in
another builder's file writes the need in its report.

| Builder | Owns |
|---|---|
| S1 sources | `convex/obligations.ts`, the `obligations` table in `convex/schema.ts`, `lib/obligations/{rules,push-policy,delivery,service}.ts`, `lib/jev/*`, `convex/jev.ts`, `lib/content/*`, `convex/content*.ts`, `lib/mcp/sync.ts`, `convex/mcpSync*.ts`, calendar sync files, their tests |
| S2 consumers | new `convex/obligationViews.ts`, new `lib/obligations/{albatross,brief-region,views}.ts`, `app/api/obligations/[id]/albatross/`, `app/api/mobile/v1/needs-you/**`, `lib/mobile/v1/*` and the OpenAPI output, the brief generation (`lib/mail/agent-report*.ts`, `lib/shared/brief-document.ts`), `convex/_generated/api.d.ts`, their tests |
| W web | `components/needs-you/**`, the Work thread components (`components/albatross/WorkThread*.tsx`, `components/albatross/thread/**`), `components/report/brief-canvas/**`, `lib/brief/letter.ts`, `lib/obligations/{groups,labels,fixtures}.ts`, `app/dev/*-preview`, their tests |
| I iOS | `apps/ios/Lab86Mail/**`, `apps/ios/Packages/MobileAPI/**`, `apps/ios/Lab86MailTests/**`, `apps/ios/Shared/**` |
| M macOS | `apps/ios/Lab86MailMac/**` and its tests. Starts after I. |

## S1: rules and sources (phases 1.1, 2, 4)

1. **Change rules (1.1).**
   - Terms, privacy, policy, and renewal notices never open an item. Add a
     Jev mail question `routine_notice` (noul): "Is the latest inbound message
     a routine notice (a terms, privacy, or policy update, a renewal or
     billing reminder, or a feature announcement) with no problem the owner
     must fix?" Do not change `JEV_VERSION` or `JEV_QUESTION_VERSION`.
   - A `change` is `time_sensitive` only when it is new (source message
     inside `CHANGE_NOW_WINDOW_MS`) and is a problem: a failed payment, a
     cancelled or moved booking, an account lock or a revoked credential.
   - A change with no `action` closes by itself after `CHANGE_AUTO_CLOSE_MS`
     as `aged_out`.
   - The 30-day fill never makes a `time_sensitive` item. Repair the owner's
     current rows with an idempotent internal migration that applies the new
     rules to open rows (no pushes).
2. **Phase 1 gaps.**
   - Push one follow-up when a `waiting` item passes its `dueAt`.
   - Link a mail item to its Albatross: take `workId` from the content label
     of the same thread (`jev_content` labels mail content items too), and
     fill `workTitle`.
   - Close an item when its thread moves to Trash or Spam (`evidence`).
   - Remove closed rows after 30 days (bounded sweep, existing cron).
3. **Connected sources (phase 2).**
   - Open, update, and resolve items from content labels (`actionable`,
     `resolved`, `workId`, `kind`) for Slack, Atlassian, Granola, and Drive,
     where the item belongs to the owner (`ownerIdentities`). Set `source`,
     `sourceLabel`, `url`, and `asker`.
   - Add GitHub and Bitbucket items (`lib/mcp/sync.ts` loaders) to the
     content index, so `jev_content` classifies them: review requests,
     mentions, assigned issues, failed checks on the owner's branches.
   - Ask the `due` question for content too.
   - The same push rules as mail. A Slack, Jira, or GitHub item pushes only
     when it passes the bar.
4. **Calendar (phase 4).**
   - `rsvp`: an invitation from another person that still waits for the
     owner's answer, for an event in the next 14 days.
   - `prepare`: a Jev question `prepare` (noul) on events in the next 24
     hours with other people: "Does the owner have to prepare something
     before this event starts?"
   - Both close as `event_passed` when the event starts. `rsvp` also closes
     when the owner answers anywhere.
   - The action `{ action: 'rsvp', response }` in
     `lib/obligations/service.ts` sends the answer through the existing
     calendar path.

## S2: consumers (phase 3 server, phase 5 API)

1. **Albatross threads.** `convex/obligationViews.ts`:
   - `forWork` (query, signed-in user, `{ workId }`): the open items of that
     Albatross and the items closed today, as `ObligationView[]`.
   - `snapshotFor` (internal secret, `{ userId }`): the `NeedsYouSnapshot`
     for the mobile routes.
2. **Start in Albatross.** `POST /api/obligations/[id]/albatross` gives
   `ObligationAlbatrossResponse`. With a `workId`: put the item into that
   thread as input and start a run (the existing run start rules apply).
   Without: start a new Albatross from the item with the existing capture
   path. Set the item's `workId`.
3. **The brief (phase 3).** For a flag user, the daily edition has a lane
   `needs-you`, title "Needs you", in the place of the `answer` lane. Build it
   from the ledger (`BriefNeedsYouRegion`, at most `BRIEF_NEEDS_YOU_LIMIT`
   items, codes never). Each item uses the same item shape as the `answer`
   lane, so the current renderers show it. `closedSince` is one plain line at
   the end ("Closed by itself since yesterday's letter: ..."). Keep the region
   in `parseBriefDocument` (repair block) and in the edition size limits.
   Users outside the flag keep `answer`.
4. **Mobile API (phase 5).** Mobile v1 routes with the existing mobile auth:
   - `GET /api/mobile/v1/needs-you` gives `NeedsYouSnapshot`.
   - `POST /api/mobile/v1/needs-you/[id]` (ObligationAction),
     `.../[id]/draft`, `.../[id]/reply`, `.../[id]/albatross`: the same
     services and responses as the web routes.
   - Add the schemas to `lib/mobile/v1/contract.ts` and run
     `bun run mobile:openapi` in the same change.

## W: web (phases 2, 3, 4)

1. Source marks and labels for each source in the row and the detail
   (`OBLIGATION_SOURCE_LABELS`, `sourceLabel`). "Open in Slack" (or Jira,
   GitHub, ...) uses `url`.
2. The detail for `rsvp` (Yes, No, Maybe) and `prepare` (the event, its
   time, the people; Done, Later).
3. "Start in Albatross" for every kind except `code`, with the response
   `workId` opening that Albatross. Show `workTitle` in the row meta.
4. The Work thread shows its items (`obligationViews:forWork`) as messages
   in time order, with the same actions (mockup `05-albatross-thread.png`).
5. The brief lane `needs-you` (title "Needs you") in `lib/brief/letter.ts`
   and the brief canvas, in the place of `answer`.
6. Phase 1.1 on the page: no change in Now unless it is `time_sensitive`.

## I: iOS (phases 3 and 5)

1. A Needs you screen in the sidebar, with the same groups, rows, detail,
   and actions as the web page (Send reply with the draft, Done, Later, Not
   mine, Undo for 10 seconds, Copy code, RSVP, Start in Albatross). Data:
   the mobile routes above (`NeedsYouSnapshot` JSON = the contract shapes).
2. A tap on an `obligation` push opens the item in Needs you. A code push
   keeps the AutoFill wake (`codeAvailable`). Do not change it.
3. The brief lane `needs-you` in `BriefLetter.swift` `classify` and in the
   brief views, in the place of `answer`.
4. Show the screen only when the snapshot says `enabled`.

## M: macOS (phase 5)

The same as I, in the Mac target, with the Mac layout (list and detail side
by side). Reuse the shared models and clients that I adds.

## Done means

- `bun run typecheck`, `bun run typecheck:tests`, `bun run lint`, and the
  full `bun test` pass. The coverage gate passes.
- Native: no Mac is reachable. The Native acceptance workflow (iOS, macOS,
  and Release archive) on the PR compiles and tests the Swift code.
- Two PRs: server and web first, native second. CodeRabbit on each. The
  merge waits for the owner.

## W notes (web, 2026-10-30)

What the web builder shipped on `claude/ny2-web`, and what it needs from the
other builders.

Pages and parts:

- Rows and details show the source word (`OBLIGATION_SOURCE_LABELS`) and the
  place in the source (`sourceLabel`): "Slack · #release". A person keeps
  initials. A meeting, an issue, a pipeline, and an event to prepare for get a
  monochrome glyph. "Open in Slack" (Jira, GitHub, ...) is a plain link to
  `url`. Only an `https` link renders.
- `rsvp`: the event card (title, start time, the people from `excerpt`), then
  Yes, No, Maybe, Later, Not mine. `prepare`: the same card, then Done, Later,
  Not mine. The event start comes from `eventStart`.
- "Start in Albatross" for every kind but `code`. With a `workId` it is the
  first action; without one it is a quiet link at the right of the action row.
  The response `workId` opens the thread. The row stays open. The row meta
  shows `workTitle`. The detail shows an Albatross card with "Open thread".
- The Work thread reads `obligationViews:forWork` and shows the items as
  cards in time order, after the conversation and before the Work questions.
  "Handle it" posts to `/api/obligations/[id]/albatross`. Done, Later, Not
  mine, and Yes/No/Maybe post to `/api/obligations/[id]`, with Undo.
- The brief lane `needs-you` renders in the place of `answer`: the accent
  surface, the kicker "Needs you", the region `summary` at the right, a "Due
  today" sub-label, and the closed line at the end.
- Phase 1.1 on the page: a `change` sits in Now only when it is
  `time_sensitive` and newer than `CHANGE_NOW_WINDOW_MS`. An older one goes to
  Today. Any other change goes by its due day and never into Now.
- Previews: `/dev/needs-you-preview?select=ob_slack_numbers` (and `ob_rsvp`,
  `ob_prepare`, `ob_jira_lab212`, `ob_drive_memo`, `ob_card`),
  `/dev/thread-preview?state=needsYou`, `/dev/brief-preview?layout=needs-you`.

Contract needs (S2 and the native builders):

- The `needs-you` region tree: an `entity_list` with the title "Needs you"
  alone, or a `stack` of that list and one `text` node (role `caption`) with
  the closed line: "Closed by itself since yesterday’s letter: ...". The web
  renders both shapes. `lib/obligations/fixtures.ts` `needsYouLetterFixture`
  shows the stack form.
- The region `summary` is the count sentence ("8 open · 2 now · 2 due today").
  The lane shows it at the kicker's right.
- Items in Now carry `framing.lane: 'now'`; items due today carry
  `framing.lane: 'today'`. The "Due today" sub-label sits before the first
  `today` item that follows a `now` item.
- `framing.age` carries the small label after the sender: the time for a
  mail item ("9:12 AM"), the source and the time for a connected item
  ("GitHub · 8:05 AM"). `framing.sender` is the asker.
- An Albatross question uses `ref.kind: 'work'` with `open_work`. A connected
  item uses `ref.kind: 'mcp'` with `open_url`. The brief has no action that
  closes an obligation; "Done" in the lane needs a new brief action.
- The chat (`components/shell/AIBar.tsx`, not a W file) has no slot for
  cards between messages. The thread shows the items in one block after the
  messages, in time order. True interleaving needs a `thread.extras` slot in
  the chat.
- The thread rail row ("Your turn · Priya asked for the Q3 numbers") is in
  `components/albatross/ThreadRail.tsx` and `lib/albatross/thread-list-view.ts`,
  not W files. It still reads the run state, not the obligations.
- The detail's Albatross card shows the title and "Open thread". The step line
  of the mockup ("Step 2 of 4 · Collect the numbers · Your turn") needs step
  data on the view; the contract has none.
