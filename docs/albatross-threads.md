# Many Albatross threads at once (PR 3)

Status: design, 2026-10-08. Branch `claude/albatross-threads`. It builds on PR 1 (the thread,
`docs/albatross-thread.md`) and PR 2 (Passwords and IDs, `docs/albatross-secure-store.md`).

## Why

Jakob, after dogfooding the thread (2026-10-08): "I should be able to have multiple threads
running. When I click back it should show a status preview like T3 Code's, and I should be able to
hop between them. I should also be able to steer them effectively."

What the code does today (mapped 2026-10-08):

- The Albatross list is not live. A row shows the title, the next step, and a state chip. It does
  not show that a run works, which step it is on, its newest log line, or new activity. A Work with
  a run going does not move up. iOS refreshes the list only on pull.
- Leaving a thread kills the chat reply: `/api/agent` passes the request signal, so Back aborts
  the stream, and the client-side save is cancelled too. Step runs continue on the server.
- Every message goes to the chat model first, which may or may not call `albatross_handle_step`.
  The direct `steer` route exists and no client uses it. There is no receipt until the next model
  step. Unread notes are lost when a run ends. Nothing can be steered, answered, or stopped from
  the list.
- At most 3 open runs per user; a 4th is refused, not queued.

## Owner decisions (2026-10-08)

1. **No practical limit on parallel runs.** Every thread may run at once, with a safety cap of 10
   open runs per user. Past the cap a run waits ("Starts soon") instead of being refused.
2. **Notes wait; "Stop and redirect" interrupts.** A normal note is read at the run's next model
   step. A separate "Stop and redirect" stops the current run at once and starts a new run with the
   note.

## User stories

Platforms: W (web), I (iOS), M (macOS).

- **T1. A live list (W I M).** I press Back. Each row shows a live status: In progress (with the
  current step and the newest log line, for example "Typed your saved Driver's license on
  dmv.ny.gov"), Answering (the chat is replying), Needs your answer, Ready for you, Starts soon,
  Done, Did not finish, Stopped. The rows that need me come first, then the ones in progress, then
  the newest.
- **T2. Unread (W I M).** A thread with activity I have not seen (a new log line that matters, a
  handoff, a reply, a question) has an unread mark until I open it.
- **T3. Hop (W M).** In a wide window the list stays open as a left rail beside the open thread.
  One click, or ⌘↑ / ⌘↓ (⌥⌘↑/↓ on the Mac if ⌘↑ is taken), moves between threads. The open thread
  is marked in the rail.
- **T4. Hop (I).** On iPhone the list is the screen behind Back, and it stays live while it is on
  screen. On iPad the list is a sidebar.
- **T5. Threads keep working (W I M).** I ask thread A a question and go to thread B. A's reply
  finishes on the server and is saved. A's row shows "Answering" meanwhile, then the unread mark.
  When I go back to A, the reply is there.
- **T6. Several runs at once (W I M).** I start runs in four threads. All four work at once. An
  11th run shows "Starts soon" and begins when one ends.
- **T7. Steer directly (W I M).** Thread A has a run in progress. I type "Use the Monday class".
  The message goes straight to the run, not to the chat model. Under my message: "Sent to the run",
  then "Read by Albatross" when the run reads it. The run log shows "Read your note: Use the Monday
  class".
- **T8. Stop and redirect (W I M).** The run goes the wrong way on a slow page. I press "Stop and
  redirect", type "Go back and choose the Saturday session", and send. The current run stops at once
  and a new run starts from there with my note.
- **T9. A note that came too late (W I M).** The run ends before it reads my note. The note is not
  lost: the next run of the step gets it first. If no run continues, the note shows "Not read: the
  run ended first" with "Send again".
- **T10. Answer and steer from the list (W I M).** A row that needs an answer has "Answer" (opens
  the question in place on web and Mac; a sheet on iOS). A row in progress has "Steer" (one line,
  sent to the run) and "Stop".
- **T11. Stop a reply (W I M).** The chat Stop button stops the server reply too, not only the
  stream on this device.
- **T12. Find a thread (W M).** With many threads, the rail has a filter: All, Needs you, In
  progress. (Search comes later.)

## Server contract (I own it; clients build against it)

- **Thread list.** Web merges `albatrossWorkV2.allWork` with the Convex query
  `albatrossThreads.activity` (the newest run of each Work and the thread state) through
  `buildThreadRows` in `lib/albatross/threads.ts`. Native reads the same rows from
  `GET /api/albatross/threads` (every 5 s while the list shows and something is in progress, else
  30 s). One row per Work that is not archived: `{ workId, title, areaName, status, statusLabel,
  preview, stepTitle, needsYou, working, latestRunId, workingRunId, runStartedAt,
  lastActivityAt, seenAt, unread, closed }`. `status` is one of `in_progress | starts_soon |
  answering | needs_answer | your_turn | ready_for_you | did_not_finish | stopped | done |
  waiting | paused | idle`. Sorted: needs you, in progress, then `lastActivityAt` desc; closed
  last.
- **Seen.** `POST /api/albatross/threads/seen { workId, unread? }` (and the Convex mutation
  `albatrossThreads.markSeen` for web) when a thread is on screen. `unread = lastActivityAt > seenAt` for activity that matters (a handoff, a
  question, a finished reply, a run that ends; not every log line).
- **Background replies.** `/api/agent` no longer aborts on disconnect. For a Work thread session
  it saves the finished messages on the server, and it marks the session `answering` while the
  reply runs. `POST /api/agent/stop { sessionId }` stops a reply on the server (T11).
- **Direct steering.** Clients send a message to a working run with `POST
  /api/albatross/work/[workId]/run { action: 'steer', runId, note }`; the thread also keeps the
  message as a user message with `metadata.steer = { runId }` (no chat turn). The run view exposes
  `notes: [{ at, text, readAt }]` so a client shows "Sent to the run" / "Read by Albatross".
  Unread notes carry to the next run of the step. `{ action: 'redirect', runId, note }` stops the
  run and starts a new run with the note (T8).
- **Limits.** `USER_RUNNING_MAX = 10` runs work at once for each user. A run past the cap stays
  `queued` ("Starts soon") and starts when a run ends. `USER_OPEN_MAX = 30` runs may be open or
  waiting; past that a start is refused with "Albatross has 30 steps open or waiting now. Try
  again when one ends." Automatic runs keep their own cap of one.

## Copy rules

As PR 1: Simplified Technical English, sentence case, no "AI" / "assistant" / "agent" in user
copy, no sparkle or star icons, no icons before text, no ALL-CAPS labels, no -ing forms in state
copy except the fixed status names above that PR 1 already uses ("In progress", "Starts soon").
"Answering" is the one new -ing label; designers may propose a better plain word.

## Cross-platform decisions (lead review, 2026-10-08)

Design notes: `docs/research/albatross-threads-{web,ios,macos}-design-2026-10-08.md`. Where they
disagree, this section wins. The server contract above is implemented; the notes below say what
changed in it.

1. **Words.** A running chat reply is "Reply in progress" (not "Answering"). A run the user
   stopped is "Stopped by you", with "Next: <step>" as its preview. Groups: "Needs you" (it
   includes "Did not finish"), "In progress", "Open" (nothing in motion), then quiet "Finished · N"
   and "Later · N" links. Filters: "All", "Needs you", "In progress" on every platform.
2. **The row.** One status dot (needs you: accent, steady; in progress and reply in progress:
   accent-2 with one slow halo, static under reduced motion; starts soon: hollow), the title
   (weight is the unread mark), line 2 "Status word · preview", the time (elapsed time from
   `runStartedAt` while a run works, else time since `lastActivityAt`). No chip, no second glyph,
   no shimmer in a list.
3. **Where the list lives.** Web: a 300 px rail (272 px on laptops, none below 1024 px) beside an
   open thread; the main sidebar drops to its icon mode while a thread is open. Mac: an
   "Albatrosses" section in the existing sidebar, not a second column. iPhone: the screen behind
   Back, plus a one-line banner when another thread needs you. iPad: a 320 pt list beside the
   thread.
4. **Hop.** Web: ⌘↑ / ⌘↓ outside text fields, ⌥⌘↑ / ⌥⌘↓ inside them, ⌥⌘↩ for the next thread
   that needs you. Mac: ⌥⌘↑ / ⌥⌘↓ and ⌥⌘↩ (a "Go" menu). Drafts, scroll position, and focus are
   kept for each thread. Drafts stay in memory only, never in browser storage or UserDefaults,
   because a draft can hold a password or an ID number; sign-out clears them. Native keeps three thread models warm. After Mark done or Archive, the
   next thread that needs you opens.
5. **Steering.** While a run works the composer sends to the run: a route line "To the run ·
   Step 2, Renew online" (Ask instead stays one click or Tab away). A sent note shows a receipt:
   "Sent to the run" → "Read by Albatross · 10:40", or "Not read: the run ended first" with "Send
   again". This reverses PR 1 decision 8. Clients send the thread message id as `noteId` and read
   `run.notes[]` (matched by id across runs, because unread notes carry to the next run).
6. **Stop and redirect.** In the thread: the press stops the run at once (`cancel`) and arms the
   composer ("What should Albatross do instead?"); send posts `resume` with the note. In a list
   row or the quick-steer sheet: one field, sent with `redirect` (stop and start in one call).
7. **From the list.** Answer in place for forms only (the PR 1 form card; allows and identity
   checks open the thread). Steer in place (one line). Stop without a confirm dialog; a notice
   offers "Continue" (resume). "Mark as unread" in the context menu on web and Mac and a leading
   swipe on iOS (`seen` takes `unread: true`).
8. **Replies that keep going.** Every client sends `sessionId` and `threadBaseUpdatedAt` with a
   Work thread chat request, and the chat Stop button also posts `/api/agent/stop`. Coming back
   to a thread whose reply still runs shows a "Reply in progress" placeholder and polls until the
   saved reply arrives (a resumable stream is a later step).
9. **Live data.** Web subscribes to `albatrossWorkV2.allWork` and `albatrossThreads.activity`
   and merges with `buildThreadRows`. iOS and macOS poll `GET /api/albatross/threads` every 5 s
   while a row is working, else every 30 s. A thread on screen calls `seen`.
10. **Attention.** Mac Dock badge = the count of threads that need you. No new push category in
    this PR. Screen readers: one merged announcement at most every 5–10 s, three event kinds
    (needs you, finished, did not finish).
