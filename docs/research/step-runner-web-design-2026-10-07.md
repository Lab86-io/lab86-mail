# Step runner, web design note (2026-10-07)

This note records the research behind the web surfaces of the step runner. The contract is
`docs/albatross-step-runner.md`. This note only decides how the states look and behave on web.

## What the user must see

- A step the agent can carry: one button, "Handle it".
- An open run: what the agent does now, the lines it wrote so far, and "Stop".
- A handoff: what the agent did, the files it made, and one next action.
- A failed run: the reason and "Try again".
- A stopped run: the limit it hit and "Continue".
- The shared browser: who has the page, and how to take it back.
- The Brief: the handoffs that wait, at the top of the newest edition.

## Reference products

### Mobbin screens (web)

- Browserbase, agent run page ([screen](https://mobbin.com/screens/38e3e1bc-2a5c-4f7b-aa64-00ab6f736224)).
  A status chip and a "Stop" button sit in the page header. The left column lists each tool call
  with a time stamp. The right column shows the live browser with "Run in progress".
  Taken: one status line and one "Stop" control; time-stamped lines; the live view beside the log.
- Relevance AI, task timeline ([screen](https://mobbin.com/screens/4366a3ad-efe2-464b-99e7-2ff4202948a5)).
  A paused task shows a banner, a "Resume task" button, and a collapsed "1 step performed in the
  background" row. Taken: a paused run offers one resume control; the work log collapses after
  the run ends.
- Cursor, cloud agent desktop ([screen](https://mobbin.com/screens/ec91b3f0-13be-436d-a971-7ef897bf5d45)).
  A "Release control" button floats over the live desktop while the user holds it. Taken: the
  control hand-over is one explicit button on the live view, not a mode switch.
- Browserbase playground ([screen](https://mobbin.com/screens/8fd030b5-9c49-43b4-8c2e-f422271a476e)).
  A toast says "You can interact with the page in real-time". Taken: say in words that the live
  view accepts input.
- Cofounder, agent run ([screen](https://mobbin.com/screens/fa55ea7d-ee1a-440b-843c-0305269a21b5)).
  "Ran 8 actions" rows collapse the activity. A summary paragraph follows. An approval chip
  ("2 Posts Need Account") sits on the artifact. Taken: a collapsed "What I did" row, then a
  summary, then the artifacts.
- Calendly, recommended follow-ups ([screen](https://mobbin.com/screens/a3340f18-8930-4f67-95de-02b155cd58d9)).
  A draft email card shows the context, the draft, and one primary "Send email" button.
  Taken: one primary action on a draft handoff.
- Workable inbox ([screen](https://mobbin.com/screens/7394bbf7-fef9-4066-89df-881515abc89c)) and
  AirOps inbox ([screen](https://mobbin.com/screens/f93ab7e5-6eff-4952-b5af-fc16246ec34e)).
  Each row has a title, a one-line summary, and one trailing button ("Sign document", "Review").
  Taken: the "Ready for you" rows carry one button each.
- Graphite inbox ([screen](https://mobbin.com/screens/b4996a23-98e4-4c42-9b4e-e06d24fbad59)).
  Sections are named by what the user must do ("Needs your review"). Taken: the list title says
  what the user does.

### Product behaviour (Browserbase fetches)

- Manus cloud browser (manus.im/docs/features/cloud-browser, help article 11711218). The agent
  shows its browser live. It asks the user to take over when it needs help. The user can also
  take over at any time. Saved logins stay in the cloud browser. Taken: "Take over" is always
  available while the agent has the page; saved sign-ins are a named setting.
- Claude in Chrome permissions guide (support.claude.com, article 12902446). The agent never
  does some actions (purchases, sensitive data entry). It pauses and asks at those points.
  Taken: the handoff card names the action the user must do, in plain words.
- Login handoff for browser agents (lite.ego.app, 2026-09-16). The handoff happens at a
  boundary: a sign-in page, an OAuth consent, a second factor, a payment. The human does only
  that step. The same browser context continues. A handoff needs a time limit and a clear
  failure state. Taken: "Sign in, then press Continue"; a stopped run says the limit it hit.
- OpenAI and Perplexity help pages were behind a bot wall. The design uses the Manus and ego
  sources for the take-over pattern.

## Decisions

1. One panel component, `StepRunPanel`, renders every state from one `StepRunView`. The Work
   page and the guided pane both mount it. The Brief mounts a list, not the panel.
2. The live log uses the `@ai-elements/task` registry component (collapsible trigger, items).
   The trigger text uses the Odyssey `ShimmerText` already in the repo. The default search icon
   is removed: no icon before text.
3. The log shows the lines oldest first, newest last, with the time of each line. A run that
   ended keeps the log in a collapsed "What I did" row.
4. The handoff card order is: headline, summary, artifacts, the one primary button, then
   "Continue" (only for `sign_in`, `finish_on_page`, `continue`), "Dismiss", "Discuss this".
5. A failed run shows the error line and "Try again". A run stopped by its limit says which
   limit, then offers "Continue".
6. The shared browser bar: status `agent` shows the session detail and "Take over" (cancel).
   Status `user` after a handoff shows the handoff detail and "Continue" (resume). The user's
   own "Check the page" and "Stop the shared browser" controls stay.
7. "Ready for you" sits under the Brief masthead, before the editorial body, only on the newest
   edition. It reads `openHandoffs` live. A row shows the Work title, the step title, one line,
   and one button. An open run shows "Working on: {step}" and the newest log line, no button.
8. A draft opens in the composer by id. The composer gets a `draftId` seed so a save updates the
   same draft. A document opens its `openPath` in Files. An approval opens Notifications.
9. All copy is Simplified Technical English. Button labels are verbs: "Handle it", "Stop",
   "Continue", "Take over", "Try again", "Dismiss", "Discuss this", "Forget saved sign-ins".

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
| Saved sign-ins | "Albatross never sees a password. The browser keeps the sign-in." |
