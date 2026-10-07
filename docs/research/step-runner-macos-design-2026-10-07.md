# Step runner, macOS design note (2026-10-07)

This note records the research behind the Mac surfaces of the step runner. The contract is
`docs/albatross-step-runner.md`. The iOS note is `step-runner-ios-design-2026-10-07.md`, and
the web note is `step-runner-web-design-2026-10-07.md`. The Mac app compiles the shared SwiftUI
code of iOS. This note decides only what the Mac adds: the wide layout, the pointer, the
keyboard, and the window sizes.

## What the Mac must do differently

- A Mac window is wide. The log and the live browser can sit side by side.
- A Mac has a pointer. Rows and cards show a hover state and a context menu.
- A Mac has a keyboard. The one primary action of a handoff answers to Return. Stop answers to
  Command-period, as in Safari.
- A Mac sheet takes the size of its content. A live browser view has no size of its own, so the
  sheet must name one.
- The Brief page is a wide column (920 points). A "Ready for you" row carries its button at the
  trailing edge, not under the text.
- Settings is a sheet with a grouped form. A destructive action is a bordered button at the
  trailing edge of its row, as in System Settings.

## Reference products

Mobbin has no macOS filter. The desktop screens below are web screens at a desktop width.

### Mobbin screens (desktop)

- Browserbase, agent run page ([screen](https://mobbin.com/screens/f6d570c4-1c95-4789-a9bd-95cffe881757)).
  A status chip, the duration, and the step count sit under the title. The left column lists
  each action with its time. The right column shows the result beside the log. Taken: the Mac
  Work page puts the live view beside the log when the window is wide.
- Browserbase, session page ([screen](https://mobbin.com/screens/1c1ee4f5-8d03-4ec9-ae86-949d8750ac94)).
  One row of facts (status, started, duration) sits over the live view. The actions list sits
  under it. Taken: one status bar over the live view, with one control at its trailing edge.
- Cursor, cloud agent desktop ([screen](https://mobbin.com/screens/ec91b3f0-13be-436d-a971-7ef897bf5d45)).
  One "Release control" button sits at the top trailing corner of the live desktop. Taken: the
  live pane has one hand-over control, "Take over" or "Continue", in its bar.
- Devin, task result ([screen](https://mobbin.com/screens/8a2e6a33-0453-4091-8c92-3bf960adec85)).
  "Worked for 11s" collapses the actions. The lines sit under it when open. Taken: the "What I
  did" disclosure keeps the log after a run ends.
- Relevance AI, task timeline ([screen](https://mobbin.com/screens/db919f38-24cb-4151-b995-2781392d7db2)).
  A details column lists Created, Status, Actions used, and Run time. Taken: the trigger line
  and the time of each log line stay visible on the Mac card.
- Twenty, task panel ([screen](https://mobbin.com/screens/ededb987-eca2-4c04-b352-545c2b874c02)).
  The "Open" button at the bottom shows its shortcut, Command-Return. Taken: the primary action
  of a handoff has a keyboard shortcut, and the shortcut list in Settings names it.
- Cofounder, agent run ([screen](https://mobbin.com/screens/d7d5d911-1ce1-4d24-ba23-e9e8cbfbe659)).
  "Ran 35 actions" collapses the activity. The summary and "What shipped" follow. Taken: the
  summary comes first, the artifacts next, the log last.
- Canny, Autopilot rows ([screen](https://mobbin.com/screens/f3ae6f8a-3f86-4c32-85a5-eb9e762b469f)).
  Each row has its actions at the trailing edge. Taken: a "Ready for you" row on the Mac has one
  trailing button.
- Deel, review cycles ([screen](https://mobbin.com/screens/c6f83fa4-218b-40c8-b31a-f12b1f144a1f))
  and QuickBooks, business feed ([screen](https://mobbin.com/screens/01b4b6ad-96d1-48e9-8b8a-10dab1115f6b)).
  One trailing "Open" or "View report" button for each row or card. Taken: the same.
- 15Five, notifications ([screen](https://mobbin.com/screens/81c2b586-253d-42c2-91be-f1d152ee5266)).
  A list and a detail pane. The detail ends with one button. Taken: a row click opens the Work;
  the button does the action.

### Product behaviour (Browserbase fetches)

- Claude in Chrome permissions guide (support.claude.com, article 12902446). The agent pauses and
  asks before a sensitive action: a download, sensitive information on a page, an authorization.
  Some actions are blocked in every mode. When an action is blocked, the agent looks for a safer
  way or pauses and asks. Taken: the handoff names the action the user must do, and the bar says
  who has the page.
- Manus, take over the browser (help.manus.im, article 11711218). Manus prompts the user to take
  over when it needs help. The user can also take over at any time inside the task. Taken:
  "Take over" is always available while Albatross has the page, in the pane and in the sheet.
- Manus desktop (manus.im/docs/features/desktop). The desktop app gives the user control over what
  the agent can see and do on the computer. Taken: the live pane names the page the agent has.
- ChatGPT agent (help.openai.com, article 11752874). The fetch on 2026-10-07 returned a bot wall.
  The iOS note recorded the page: the agent pauses at a login and asks the user to take over;
  while the user has the browser, the agent takes no screenshots; saved logins can be cleared.
  Taken: Return confirms "Continue" after the user did their part.

## Decisions

1. The Mac adds a split, `MacStepRunSplit`, around the "Do this next" section. When the detail
   column is at least 960 points wide, and the run owns a page (an open run with a browser
   session, or a `sign_in` or `finish_on_page` handoff), the step and its card sit at the left
   and the live pane sits at the right. The pane takes about half the width, between 460 and
   640 points, and is 420 points tall. A narrow window keeps the iOS layout.
2. The live pane, `MacStepRunLivePane`, follows the same session row as the sheet
   (`albatrossBrowserSessions:activeSessionForWork`). Its bar shows the status dot, the status
   line from `StepRunBrowserPresentation`, and one control: "Take over" while Albatross has the
   page, "Continue" after a handoff. "Larger view" opens the sheet. The pane never starts or
   ends a session.
3. The shared browser sheets name a Mac size: 1180 by 760 points minimum (`MacSheetSize
   .liveBrowser`). This applies to the run sheet and to the user's own "Work on this page here"
   sheet, which had no Mac size before.
4. Keyboard: Return triggers the primary button of a handoff card and "Continue" of a stopped
   card. Command-period triggers "Stop" on the open card. In the sheet, Return is "Continue",
   Command-period is "Take over", and Escape is "Close". "Handle it" and "Try again" have no
   shortcut: a run costs money, and one key press must not start one.
5. Pointer: a handoff card has a context menu with the primary action, "Continue", "Copy the
   summary", "Dismiss", and "Discuss this". An artifact row shows a hover fill. A "Ready for
   you" row shows a hover fill and a context menu with "Open the Work", the primary action,
   and "Dismiss".
6. The Brief "Ready for you" row on the Mac is one line of text at the left and one button at
   the trailing edge. An open run shows a small spinner, "Working on: {step}", and the newest log
   line, with no button. A click on the row opens the Work.
7. Settings, Saved sign-ins on the Mac: the "Forget saved sign-ins" row carries a bordered
   "Forget…" button at its trailing edge. The confirmation dialog stays the same.
8. The Mac tour gains two screens: `mac-work-detail-run` and `mac-work-detail-handoff`, from the
   same fixtures as the iOS screens. The Mac Today screen already shows "Ready for you", because
   the handoffs fixture answers every scenario.
9. All copy is Simplified Technical English. No icon before text. No star or sparkle symbol.

## Shortcuts

| Key | Where | Action |
|---|---|---|
| Return | Handoff card, stopped card | The primary button, or "Continue" |
| Command-period | Open run card | "Stop" |
| Return | Shared browser sheet | "Continue" |
| Command-period | Shared browser sheet | "Take over" |
| Escape | Shared browser sheet | "Close" |

## Copy table (Mac additions)

| State | Line |
|---|---|
| Live pane, no page yet, run open | "Albatross has not opened a page yet. The live view shows here when it does." |
| Live pane, no page, handoff | "The shared browser is closed. Press Continue. Albatross opens a new one when the step needs it." |
| Live pane control | "Take over", "Continue", "Larger view" |
| Settings row | "Forget saved sign-ins" with the button "Forget…" |
| Context menu | "Open the Work", "Copy the summary", "Dismiss", "Discuss this" |

## Open items

- The Mac tour runs without Convex, so the live pane shows its "no page yet" state in the run
  screen. A screenshot with a real live view needs a signed-in Mac.
- `cacheDisplay` does not draw a WKWebView. The run screen shows the pane chrome, not a page.
