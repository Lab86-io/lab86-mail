# Brief round 2026-09-22

Design note and shared contract for the Daily Brief and Area brief round. Branch
`claude/brief-round-2026-09-22`, based on `origin/main` at v0.16.1. Target: the
`staging` branch.

## Goal

The brief loads more than it shows. This round shows what the pipeline already
loads, closes the loop between the evening check-in and the morning letter, and
gives each item the actions the clients already render. The area brief becomes
a living document with a week ahead and a refresh cadence.

## What main already has

PR #276 to #283 landed the Jev relevance layer. The following gaps from the
2026-09-22 analysis are closed on main and are not part of this round:

- Domain-wide familiarity in the score.
- Eligibility gate before scoring.
- Reply duty from message direction alone.
- Answer lane cap of 3.
- Overflow backlog (web only).
- Scoped corrections (sender, list, thread).
- Live projection of the latest edition.

## Shared contract

### Daily letter regions

The daily letter region ids, in order. New ids are marked.

| Region | Node | Content |
| --- | --- | --- |
| `lede` | hero | Unchanged. |
| `yesterday` (new) | text, role `body` | The check-in reflection, the stated intent, work completed since the previous edition, and agent operations since the previous edition. Written by the prose model as `yesterday`, at most 3 sentences. Deterministic fallback. Omitted when there is nothing. |
| `answer` | entity_list | Thread items. Actions: `open_thread`, `draft_reply`, `dismiss_thread`. |
| `today` | entity_list | Events first, then thread items. Thread actions: `open_thread`, `create_task` when a due date exists, `dismiss_thread`. Event action: `open_event`. |
| `know` | entity_list | Thread items. Actions: `open_thread`, `dismiss_thread`. |
| `waiting` (new) | entity_list | Threads the user waits on. Jev waiting obligation, or follow-up owed, or a tracked thread in `waiting` state. Not already in a lane. Cap 4. Actions: `open_thread`, `resolve_thread`. |
| `tasks` (new) | entity_list | Open task cards due inside 7 days. Cap 5. Ref kind `task`, id = cardId. Actions: `toggle_task` with `completed: true`, `dismiss_task`. |
| `connected` (new) | entity_list | Connected-tool items ranked by relevance. Cap 4. Ref kind `mcp`, id = externalId. Action: `open_url`. |
| `week-ahead` | text, role `body` | Unchanged. |
| `areas` | entity_list, compact | Unchanged. |

Rules:

- Each thread item keeps the `open_thread` action first. Clients treat the first known action as the row tap.
- `dismiss_thread` and `resolve_thread` payloads carry `account`, `threadId`, `subject`, `receivedAt`.
- `draft_reply` payload carries `account`, `threadId`, `subject`.
- `create_task` payload carries `title`, `dueAt`.
- `toggle_task` payload carries `cardId`, `completed`, `title`.
- `open_url` payload carries `url`.
- `framing.age` is a new optional string, at most 40 characters, for example `Day 3`. It is set when the same thread appeared in an earlier edition. Clients show it as a small label after the sender.
- `framing.lane` is `waiting`, `tasks`, or `connected` for the new regions.

### Area letter regions

| Region | Node | Content |
| --- | --- | --- |
| `lede` | hero | Unchanged. |
| `pulse` | stack of text | Unchanged. |
| `ask` | prompt | Unchanged. |
| `week` (new) | text, role `body` | The area's next 7 days: events, routines due, tasks due. Written by the pulse model as `weekAhead`, at most 3 sentences. Deterministic fallback. |
| `mail` (new) | entity_list | Verified mail linked to the area, newest first, unread or with a reply duty first. Cap 4. Actions: `open_thread`, `draft_reply`. |
| `open-work` | query_list | Unchanged. |

The area pulse gains two optional fields: `weekAhead` and `sinceLastBrief`. Both
are stored on the area brief row.

### Notifications

- `brief_ready` notifications carry the first sentences of the lede as the body, at most 180 characters.
- The deep link stays `/brief?id=<reportId>`. Clients open that edition, not the latest one.

### Brief state on native

Native clients call `POST /api/brief/state` with the work, task, and card refs of the document and hide the refs that come back as inactive. This matches the web.

### Telemetry

`POST /api/brief/events` records one row per user action on a brief item.

```json
{
  "reportId": "optional edition id",
  "surface": "daily" | "area",
  "regionId": "answer",
  "action": "draft_reply",
  "ref": { "kind": "thread", "id": "...", "account": "..." },
  "outcome": "done" | "failed" | "undone" | "opened"
}
```

Clients post after the action settles. A failure to post never blocks the action.

### Schedules

- The morning cron fires at local 07:00. A catch-up pass fires at local 08:00 to 11:00 for users with no morning edition for the local date.
- A new cron refreshes area briefs every 3 hours without `force`. The generator short-circuits when the source revision has not changed.

## Platform work

### Server (Claude, this session)

- `lib/mail/brief-budget-document.ts`: new regions, item actions, `framing.age`.
- `lib/mail/brief-prose.ts`: `yesterday` prose, `carriedDays` on items.
- `lib/mail/daily-report.ts`: `sections.waiting`, `firstSurfacedAt` on items.
- `lib/mail/brief-connected.ts`: MCP ranking.
- `lib/mail/agent-report.ts`: previous edition lookup, since-last-edition loads.
- `lib/albatross/area-living-brief.ts`: `weekAhead`, `sinceLastBrief`, `week` and `mail` regions.
- `lib/brief/letter.ts`: region ids.
- `convex/dailyReports.ts`: catch-up pass, area refresh cron.
- `convex/albatrossNotifications.ts`: `body` on `queueBriefReady`.
- `convex/albatrossWork.ts`: completions since a time.
- `convex/briefEvents.ts` and `app/api/brief/events/route.ts`: telemetry.
- `app/api/cron/area-briefs/route.ts`: `force` from the body.
- Tests for each change.

### Web (subagent)

- `components/report/brief-canvas/BriefLetter.tsx`: render `yesterday`, `waiting`, `tasks`, `connected`, area `week` and `mail`; show `framing.age`; render every known action on a row, not only the first.
- `components/notifications/model.ts` and `components/shell/AppShell.tsx`: honor the edition id in the deep link.
- `components/report/brief-canvas/BriefCanvas.tsx`: unknown actions fail visibly; remove the unreachable `project` ref filter; show the `unread` hydration mark; post telemetry.
- Tests for each change.

### iOS and macOS (subagent)

- `BriefLetter.swift`: the new regions and `framing.age`; every known action on a row.
- `BriefDocumentView.swift`: call `POST /api/brief/state` and hide inactive refs; post telemetry.
- `NavigationModel.swift`: open the edition named in the deep link.
- `TodayView.swift`: show the overflow backlog under the letter.
- `MobileAPI/BriefDocument.swift`: `age` on framing.
- Build and test both schemes on the Mac.

## Verification

- `bun test`, `bun run typecheck`, `bun run lint`, `bun run build`.
- Xcode build and test for `Lab86Mail` and `Lab86MailMac` on the remote Mac.
- Push to `staging` and confirm the deploy.
