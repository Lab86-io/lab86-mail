# Step runner, iOS design note (2026-10-07)

This note records the research behind the native surfaces of the step runner. The contract is
`docs/albatross-step-runner.md`. The web note is `step-runner-web-design-2026-10-07.md`. This
note decides how the states look and behave on iOS. The macOS agent reads it too: the shared
SwiftUI code is platform-neutral, and the Mac adds its own layout after this round.

## What the user must see

- A step Albatross can carry: one primary button, "Handle it".
- An open run: the step Albatross works on, the lines it wrote so far, and "Stop".
- A handoff: what Albatross did, the files it made, and one next action.
- A failed run: the reason and "Try again".
- A stopped run: the limit it hit and "Continue".
- The shared browser: who has the page, and how to take it back.
- The Brief: the handoffs that wait, at the top of the newest edition.
- Settings: the saved sign-ins, and one button to forget them.

## Reference products

### Mobbin screens (iOS)

- Manus, task run ([screen](https://mobbin.com/screens/59294d00-2e82-406d-a422-a8efa4cd10ab)).
  A plan card lists the steps. A check marks a done step. The current step shows a "Thinking"
  line under it. One stop control sits in the composer. Taken: the open run shows one line for
  what happens now, and one "Stop" control.
- Manus, task done ([screen](https://mobbin.com/screens/2c036db9-3d89-4b7e-82e4-6c116dc7f53d)).
  The result text comes first. A file row shows the name, the kind, and the size. A line says
  "Task completed". Taken: the handoff card puts the summary first, then the artifacts as rows.
- ChatGPT, research run ([screen](https://mobbin.com/screens/1b34f932-9df1-4d93-8e27-c9a7ac490ba5)).
  A card lists the planned work with empty circles, a status line "Researching…", a progress
  bar, and one stop button. Taken: a short status line and one "Stop" control on the card.
- Perplexity, agent run ([screen](https://mobbin.com/screens/4ea08f69-9f99-40a6-bc83-f003dcd20d3c)).
  Each action is one line with a chevron. A short paragraph follows when the agent changes
  phase. Taken: the log is a list of short lines, oldest first, in a quiet well.
- Notion, meeting notes ([screen](https://mobbin.com/screens/a483c1af-bd45-4751-aa6b-d510acd34ac2)).
  Done lines carry a check; the current line carries a spinner. A bar at the bottom says what
  happens and that the app may stay open. Taken: one spinner next to the current step title.
- Grok Bot, sign-in sheet ([screen](https://mobbin.com/screens/cd2adf9e-0ec6-42df-bd6d-86785fb4d26c))
  and Sesame ([screen](https://mobbin.com/screens/e87ec3c0-fff0-43d7-802a-429029caee1d)).
  A sheet shows the site name in a bar at the top and the sign-in page below it. One line under
  the page says why the user is there. Taken: the shared browser is a sheet with one status bar
  at the top; the bar says who has the page.
- Comet, page menu ([screen](https://mobbin.com/screens/5585d8b9-6d36-4c9b-8df9-4991b988e359)).
  The page actions are a plain list of verbs. Taken: the sheet toolbar holds verbs only.
- Airwallex, request approval ([screen](https://mobbin.com/screens/64c52224-dd85-4916-a31d-97a03c55a5c1)).
  A timeline shows what happened and the current step. One primary button ("Approve") sits
  above one secondary button. Taken: one primary button and one quieter second button.
- Remote, pending requests ([screen](https://mobbin.com/screens/6f7ddbc3-3a49-492b-8de8-5f7c791cdf28)).
  A "Pending requests · 1" section sits on the home page. Each row has one line and two
  buttons. Taken: the "Ready for you" list is a named section with one row for each Work.
- Deel, home ([screen](https://mobbin.com/screens/28f8bdc3-5ea8-4bb8-b0f7-0ff4bab4bb2c)).
  "Upcoming actions" rows each carry one trailing button. Taken: one button for each row.

### Product behaviour (Browserbase fetches)

- ChatGPT agent (help.openai.com, article 11752874). When a task needs a login, the agent
  pauses and asks the user to take control of the browser ("Take over browser"). While the
  user controls the browser, the agent takes no screenshots. After the user gives control
  back, the agent continues from the last state. Cookies stay across sessions. The user can
  clear saved logins in the data controls. Taken: the handoff says "Sign in, then press
  Continue"; Albatross never sees the password; "Forget saved sign-ins" is one setting.
- Manus (help.manus.im, article 11711218). Manus asks the user to take over when it needs
  help. The user can also take over at any time. Taken: "Take over" is always available while
  Albatross has the page.
- The Perplexity Comet page is behind a bot wall. The design uses the ChatGPT and Manus
  sources for the take-over pattern.

## Decisions

1. One view, `StepRunCardView`, draws every run state from one `StepRunCardState`. The "Do
   this next" section of the Work page mounts it. The Brief mounts a list, not the card.
2. The card state is a pure function, `StepRunCardPolicy.state(step:execution:)`. The rule:
   runner off → no controls; an open run → the open card; a `handed_off` run with a limit →
   the stopped card; `handed_off` → the handoff card; `failed` → the failed card; else
   "Handle it" when the step is runnable.
3. The open card shows a spinner, "Working on: {step}", the newest log line, the last four
   lines in a quiet well with their times, and "Stop". "Show all" reveals the whole log.
4. The handoff card order is: headline, summary, next detail, artifacts, "What I did"
   (the log, collapsed), the one primary button, then "Continue" (only for `sign_in` and
   `finish_on_page`), "Dismiss", "Discuss this". The usual step buttons hide while a handoff
   card shows. "Dismiss" brings them back.
5. A failed run shows "This run did not finish.", the error line, and "Try again". A run
   stopped by its limit says which limit, then offers "Continue".
6. The shared browser for a run is a second sheet, `StepRunBrowserSheet`. It never starts or
   ends a session: the run owns the session. The sheet follows the live session row
   (`albatrossBrowserSessions:activeSessionForWork`). Status `agent` shows the session detail
   and "Take over" (cancel). Status `user` shows the handoff detail and "Continue" (resume).
   The user's own "Work on this page here" sheet stays as it is.
7. "Ready for you" sits at the top of the Brief body, before the narrative, only on the newest
   edition. It polls `GET /api/albatross/handoffs` every 20 seconds while the app is active.
   A row shows the Work title, the step title, one line, and one button. An open run shows
   "Working on: {step}" and the newest log line, no button. A tap on the row opens the Work.
8. The primary button does the same thing on the Work page and in the Brief. A draft opens in
   the composer with its text and its id, so a save updates the same draft. A document opens
   by id, or by the `office`/`document` query of its `openPath`. An approval opens Activity.
   A browser or question handoff from the Brief opens the Work page, where the sheet and the
   question live.
9. While a run is open on a visible Work page, the page reads `work_home` every three seconds.
   The read stops when the page goes away or the run ends.
10. Settings, Trust gains "Saved sign-ins". It says when a sign-in context exists and offers
    "Forget saved sign-ins" behind a confirmation. The standing orders list already draws
    "Work on steps by itself" from the server; no change.
11. All copy is Simplified Technical English. Button labels are verbs. No icon before text.

## Copy table

| State | Line |
|---|---|
| queued | "Waiting to start." |
| running, no log | "Albatross works on this step." |
| handed off, ready_for_you | "Ready for you" |
| handed off, your_turn | "Your turn" |
| handed off, needs_answer | "Albatross needs one answer" |
| handed off, stopped (time) | "Albatross stopped at its time limit." |
| handed off, stopped (cost) | "Albatross stopped at its cost limit." |
| failed | "This run did not finish." + error |
| browser, agent has the page | session detail, or "Albatross has the page." |
| browser, your turn | handoff detail, or "Your turn on the page. Press Continue when you are done." |
| browser, closed | "The shared browser is closed." |
| Saved sign-ins | "Albatross never sees a password. The browser keeps the sign-in." |

## Open items for the macOS agent

- The Work page sections and the card use the shared layout. The Mac may want the log and the
  live view side by side, as the web does.
- `StepRunBrowserSheet` is a `NavigationStack` sheet. The Mac sheet chrome
  (`MacSheetChrome`) may want its own toolbar.
- The Mac tour has no screen for the new states yet.
