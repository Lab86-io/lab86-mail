# Refinement round 2026-09-03

Status: in progress on `staging`. Owner: Claude. Decided by Jakob on 2026-09-03.

This round refines five features, removes bloat, and improves speed. Each feature ships on
web, iOS, and macOS in the same change. One implementation subagent per platform builds each
feature. Design research comes first, as a planning step: one design-research subagent per
platform uses Mobbin for UI ideation and Browserbase for reference behavior, and writes a
design note under `docs/refinement-round-2026-09-03/<platform>.md`. The implementation
subagents build from those notes. Research is never a verification step.

## Rules for every subagent

- Write all user-facing copy, comments, docs, and commit text in ASD-STE100 Simplified
  Technical English. Short sentences. Active voice. One instruction per sentence.
- Taste rules: no sparkle or star icons, no icon before text in a button, no ALL-CAPS
  micro-labels, no meaningless copy. Use plain verbs. Never write the word "AI" in user copy.
- Add or update focused tests for every behavior, state, data, routing, or contract change.
- Any change to `lib/mobile/v1/contract.ts` regenerates OpenAPI with `bun run mobile:openapi`.
- Keep the mobile v1 contract aligned across web, iOS, and macOS.
- Stay inside your platform's file scope. Re-read a file before you edit it. Other subagents
  edit other directories in the same tree at the same time.
- Do not commit. The orchestrator commits after verification.
- Convex: never run `convex codegen` or `convex dev` locally (it pushes to a deployment).
  Hand-edit `convex/_generated/api.d.ts` for new modules. Every new schema table must be
  added to `deleteUserCascade` in `convex/accounts.ts` (a compliance test enforces it).
- Coverage: every new file needs at least 70% line coverage in `bun test --coverage`. Use a
  dependency-injection seam (see `lib/tools/albatross.ts`) so logic is testable without I/O.
- Web verification: `bun run typecheck`, `bun run lint`, `bun test` (scope test runs to your
  files while you iterate, run the full suite at the end).
- Native verification runs on the build Mac (`ssh mac`). See "Native build loop" below.

## Platform file scopes

- Web: `app/**`, `components/**`, `lib/**` (client and shared), `convex/**` (only the shared
  layer subagent edits `convex/schema.ts`), `tests/**`.
- iOS: `apps/ios/Lab86Mail/**`, `apps/ios/Shared/**`, `apps/ios/Packages/MobileAPI/**`,
  `apps/ios/Lab86MailTests/**`. iOS-only code uses `#if os(iOS)`.
- macOS: `apps/ios/Lab86MailMac/**`, plus Mac branches (`#if os(macOS)`) inside shared
  SwiftUI files under `apps/ios/Lab86Mail/**` when a view needs a Mac-specific layout. The
  Mac target is `Lab86MailMac` in `apps/ios/project.yml`. See `docs/mobile/macos-target.md`.

## Native build loop

Host `mac` (M3 Pro, Xcode 27 at `/Applications/Xcode-beta.app`). Sync the tree, generate the
project, then build or test. Long commands must run detached with `nohup` and a status file,
then poll. Use `${PIPESTATUS[0]}`, not the exit code of `tail`.

```sh
rsync -a --delete --exclude 'Lab86Mail.xcodeproj' apps/ios/ mac:/Users/jjalangtry/Developer/albatross-verify/ios/
ssh mac 'cd ~/Developer/albatross-verify/ios && printf "exit 0\n" > ci_scripts/verify_built_configuration.sh && ~/tools/xcodegen/bin/xcodegen generate 2>/dev/null || /opt/homebrew/bin/xcodegen generate'
# iOS
ssh mac 'cd ~/Developer/albatross-verify/ios && nohup env DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer bash -c "xcodebuild build -project Lab86Mail.xcodeproj -scheme Lab86Mail -destination \"generic/platform=iOS Simulator\" CODE_SIGNING_ALLOWED=NO > /tmp/ios-build.log 2>&1; echo EXIT:\$? >> /tmp/ios-build.log" > /dev/null 2>&1 &'
# macOS
ssh mac 'cd ~/Developer/albatross-verify/ios && nohup env DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer bash -c "xcodebuild build -project Lab86Mail.xcodeproj -scheme Lab86MailMac -destination \"platform=macOS\" CODE_SIGN_IDENTITY=- > /tmp/mac-build.log 2>&1; echo EXIT:\$? >> /tmp/mac-build.log" > /dev/null 2>&1 &'
```

The verify tree overrides `ci_scripts/verify_built_configuration.sh` with `exit 0` because
`Config/Local.xcconfig` is staging-configured. Never change that script in the repo.

## Order of work

1. Wave A: Today cleanup, horizon, dormant Work, terminal verification.
2. Wave B: Calendar sync kicks.
3. Wave C: Brief budget, scoring, light prose.
4. Wave D: Shapes with their own contracts and views. `list` first.
5. Wave E: One bar for Ask and Hold.

Each wave: the shared layer lands first, then three platform subagents run in parallel.

---

## Wave A. Today cleanup, horizon, dormant Work, terminal verification

### Stories

- Jakob says "I need to renew the passport, but not before November." The Work is kept.
  It does not appear on Today. It does not get moved, checked, or asked about. On November 1
  it wakes up with one calm line: "Passport renewal is back. Ready when you are."
- Jakob opens Today. He sees his day, the important mail, and at most one next move. No
  stack of albatrosses sits above the calendar.
- A step is confirmed by a real calendar event. It is never checked again.

### Shared contract

`albatrossIntents.horizon` (optional):

```ts
horizon?: {
  kind: 'now' | 'later' | 'someday';
  notBefore?: number;  // epoch ms. Work is dormant while now < notBefore.
  by?: number;         // epoch ms. A soft target date, shown, never enforced.
  label?: string;      // the user's own words, e.g. "after the wedding"
  wokeAt?: number;     // set once when the wake nudge fired
}
```

Pure helpers in `lib/albatross/horizon.ts`:

- `isDormant(work, nowMs)`: `horizon.notBefore` in the future.
- `horizonLine(horizon, nowMs)`: one short line for UI ("Back on Nov 1", "Someday",
  "By Friday").
- `parseHorizonHint(text, nowMs)`: deterministic parse of common phrases
  ("in two weeks", "next month", "someday", "by Friday", "not before November").
  The capture split also asks the model for a horizon; the deterministic parse is the
  fallback and the test oracle.

Dormant Work is excluded from: `selectExecutionSnapshot`, `needsYouToday`, `openWork`,
`readyToMove`, `isStale`, `mailWatchCandidates`, `stalenessReviewCandidates`, missed-move
candidates. Dormant Work is included in the Work page under a "Later" shelf, sorted by
`notBefore`.

Wake: a daily cron (`horizon wake`) finds Work with `notBefore <= now` and `wokeAt` unset. It
sets `wokeAt`, sets `horizon.kind = 'now'`, and writes one `albatrossNotifications` row with
copy "{title} is back. Ready when you are."

Mutation: `albatrossWorkV2.setHorizon({ workId, horizon | null })`.

Terminal verification: `stepVerification` at level `confirmed` is final. `mailWatchCandidates`
and the evidence gate skip steps that already hold a `confirmed` verification.

Conductor quiet rule: the conductor does not move Work the user has not touched in the
current session, unless a horizon wakes it or the user asked for a plan.

Mobile v1: `horizon` on the Work payload, `work.setHorizon` command.

### Today surface

Remove the albatross stack from Today on all platforms. Today shows: the dateline, the day
ribbon (calendar), important mail (max 4), and one "next move" line when a move is scheduled
for today. The "Still carrying this?" review moves to the Work page. The `LapsePrompt` banner
above the calendar grid is removed; missed moves show only inside the Work detail.

### Expression ideas (pick what fits each platform)

- The "Later" shelf is a horizontal timeline, not a list. Each dormant Work is a card at its
  wake date. Cards without a date sit at the far end under "Someday".
- The wake nudge slides in from the right edge with the Work title and one button: "Open".
- Setting a horizon is one control: a segmented "Now / Later / Someday" with a date field that
  appears only for "Later". Natural language accepted ("after Thanksgiving").

---

## Wave B. Calendar sync kicks

### Stories

- Jakob creates an event in the app. Five seconds later the calendar shows the server copy
  with the attendee status filled in.
- Jakob opens the calendar on his phone. If the last sync is older than two minutes, a sync
  runs in the background. A thin progress line shows at the top and disappears.
- Jakob pulls down on the calendar. It syncs now.

### Shared contract

- `createCalendarEvent`, `updateCalendarEvent`, `deleteCalendarEvent` call
  `maybeKickCalendarSync(row, { force: true, reason: 'post_mutation' })` after the mirror
  write.
- `POST /api/calendar/resync` accepts `{ reason: 'view_open' | 'pull' | 'manual_http' }`.
  `view_open` is debounced server-side: no sync if the last sync finished under two minutes
  ago. `pull` and `manual_http` always sync (existing rate limit stays).
- The response returns `{ started: boolean, lastSyncedAt }` so clients can show state.
- Mobile v1: `calendar.resync` command with `reason`.

---

## Wave C. Brief budget, scoring, light prose

### Stories

- Jakob opens the brief at 07:00. It reads like a short letter from a good assistant. One
  lede paragraph. Then seven items at most, each with the real email (sender, subject, one
  line on why it matters, and an open action). Then a short "week ahead" paragraph: "This
  Thursday you can send the passport form. Friday is open."
- Nothing in the brief is a summary of a summary.

### Shared contract

- `BRIEF_ITEM_BUDGET` by plan tier: `{ free: 5, pro: 7, team: 9 }`.
- Three lanes replace the seven: `answer` (reply owed, max 3), `today` (calendar and
  deadlines), `know` (max 3). `bulkTail`, `newPeople`, `fyi`, `tracked` lanes are removed
  from the document. The noise summary becomes one number in `stats`.
- Deterministic score before any model call, in `lib/mail/brief-score.ts`:
  direct-to-you +3, sender the user has replied to before +3, thread the user took part in
  +2, deadline within 48 hours +3, `llmCategory` in {`needs_reply`, `commitment`} +2,
  list or bulk sender -4. Top-K by score fills the budget.
- The model writes: the lede (max 4 sentences), one line per item (max 20 words), and the
  "week ahead" paragraph (max 4 sentences, concrete dates and weekday names). The model may
  write nothing for an item.
- `CANDIDATE_LIMIT` drops to 120 and the enrich cap to 12.
- Area brief: drop the self-contained HTML artifact. The area brief becomes a structured
  pulse `{ lastChange, nextMove, openQuestion, prose }` where `prose` is at most 3 sentences.
  The daily brief embeds at most 3 areas, 1 line each.
- Keep the brief document v2 node tree so native hydration keeps working. The composer
  emits fewer nodes: hero (lede), one `entity_list` per lane, one text body (week ahead).

---

## Wave D. Shapes with their own contracts and views

### Stories

- "Movie list: Heat, Alien, Dune part two." Albatross keeps a list. No plan. No steps. No
  verification. It never goes stale. Later Jakob says "add Blade Runner to the movie list"
  in chat and it appears.
- "Lose fifteen pounds by spring." A practice with a metric. Jakob logs a weight when he
  wants. The detail view shows the trend, the streak of weeks with a log, and a weekly
  review. No steps to verify.
- "Ship the Albatross Mac app." A project with milestones. Evidence is commits, PRs, and
  docs, not browser proof. The detail view shows a milestone board and a log with "last
  touched".

### Shared contract

`WORK_SHAPES` gains `list`. Shape policy in `lib/albatross/shape-policy.ts`:

| Shape | plans | verifies | staleAfterDays | mailWatch | staleness | missedMove | detail |
|---|---|---|---|---|---|---|---|
| quick | yes | yes | 14 | yes | yes | yes | guided |
| list | no | no | null | no | no | no | list |
| project | milestones | artifacts | 45 | no | yes | no | milestones |
| practice | no | metric | null | no | no | no | practice |
| decision | options | choice | 21 | no | yes | no | decision |
| monitor | no | condition | null | yes | no | no | monitor |
| recurring | no | run | null | no | no | no | routine |

Every conductor candidate query reads the policy. A shape with `mailWatch: false` never
appears in `mailWatchCandidates`, and so on.

New fields on `albatrossIntents`:

```ts
listItems?: Array<{ id: string; text: string; done: boolean; addedAt: number; doneAt?: number }>;
metric?: { name: string; unit: string; target?: number; direction?: 'down' | 'up' };
milestones?: Array<{ id: string; title: string; done: boolean; doneAt?: number; order: number }>;
```

New table `albatrossMetricEntries { userId, workId, at, value, note? }` with index
`by_work_at`.

Mutations in `albatrossWorkV2`: `addListItem`, `toggleListItem`, `removeListItem`,
`logMetric`, `setMilestones`, `toggleMilestone`, `setShape`.

Capture: the split recognizes lists and returns `shape: 'list'` with `listItems`. It
recognizes a metric goal and returns `shape: 'practice'` with `metric`.

Chat tools: `albatross_list_add`, `albatross_metric_log`. The turn reconcile maps them.

Mobile v1: the new fields on the Work payload, and commands `work.listAdd`,
`work.listToggle`, `work.metricLog`, `work.milestoneToggle`, `work.setShape`.

### Expression ideas

- List: quick add at the top, one line per item, tap to check. A checked item settles to the
  bottom with a short ease. Long-press to remove. The list has no header chrome.
- Practice: a small trend line drawn from the entries, the current value large, the target as
  a thin marker. One button: "Log". The weekly review is one sentence generated on device
  from the numbers, no model call.
- Project: milestones as a vertical rail with the done ones filled, the current one open, the
  rest hollow. The log below shows the artifacts in time order.

---

## Wave E. One bar for Ask and Hold

### Stories

- Jakob types "what did Sarah say about the venue?" The bar shows `Ask`. Enter sends it to
  chat.
- Jakob types "book the dentist before the trip". The bar predicts `Hold`. He can press Tab
  to flip it to `Ask`. Enter does not produce a chat reply. The bar turns into the parsed
  Work card with its shape and horizon, and the card slides into the Work rail.
- Mid-chat, the assistant suggests three steps. Jakob taps "Hold this" on the reply. The
  steps become a Work.
- Intents are stored as intents. Chats are stored as chats. Nothing crosses over unless
  Jakob chose it.

### Shared contract

- `POST /api/albatross/route` `{ text }` returns `{ route: 'ask' | 'hold', confidence }`.
  Fast model, 3 second timeout, falls back to `ask`. Rate limit 60/min.
- Agent tool `albatross_capture_work({ text, shape?, horizon? })` calls `captureWork`.
- "Hold this" on a chat reply posts the reply text plus the user's message to
  `/api/albatross/capture` with `source: 'chat'` and `conversationId`.
- Mobile v1: `assistant.route` command and `work.captureFromChat` command.

### Expression ideas

- The route chip sits at the right edge of the input. It reads `Ask` or `Hold`. Tab flips
  it. The chip color follows the route: accent-1 for Ask, accent-2 for Hold.
- The Hold landing: the input collapses into a card in place, the card shows the title,
  the shape word, and the horizon line, then the card moves to the Work rail. Under 600 ms.
- Native: iOS uses the same bar at the bottom of the chat surface. macOS uses the bar in the
  chat panel and also in the ⌘K position when the panel is closed.
