# Needs you: web design note

Date: 2026-10-30. Status: mockups only, no app code. The design is in
`docs/needs-you.md`. This note records the layout and component decisions
behind the mockups, the states, the keyboard model, and the open questions.

The mockups are in `/tmp/needs-you-mockup/` (one HTML file per screen, one
shared CSS file, PNG renders at 1440 x 900 at 2x, and `index.html` as a
gallery). The lead publishes them. All people, companies, and places are
invented.

## Files

| File | Screen |
|---|---|
| `01-needs-you.png` | The page. A time-sensitive change is open in the detail. One row shows the hover actions. |
| `01-needs-you-dark.png` | The page in the dark theme. The list is scrolled to Waiting on others and Closed today (open). A `waiting` item is open. |
| `02-mail-reply.png` | Detail of a mail reply with the prepared draft. |
| `03-albatross-item.png` | Detail of a Slack item that belongs to an Albatross. |
| `04-code.png` | A sign-in code, in the row and in the detail. |
| `05-albatross-thread.png` | The obligation as a message in the Work thread. |
| `06-brief-region.png` | The Daily Brief with the Needs you lane. |
| `07-rail.png` | The bell count, its tooltip, the in-app toast, and the empty detail. |
| `08-settings.png` | Settings, Notifications. |

## Tokens and type

- Every color comes from `app/globals.css`: the OKLCH surface ladder, the
  accent (hue 156), accent-2 (hue 45), and accent-3 (hue 250). The dark
  theme uses the dark block of the same file.
- Fraunces sets the page title, the asker names, and the thread titles.
  Geist sets body text and controls. Geist Mono sets the one key hint.
- Radius is `--radius-ui` (14 px, superellipse). Full circles are for
  avatars and status dots only.
- Each accent has one job. Accent: the primary action, the selected row, and
  the Albatross status word. Accent-2: time-sensitive items, the code
  expiry, and the "Why this needs you" kicker. Accent-3: due-day words, as
  the weekday names in the brief. Success: "Done", "Used", and "Closed by
  itself".

## Screen 1: the Needs you page

Layout. The page keeps the shell of the Notifications page: a header with
the serif title, a list of 440 px, and a detail panel. The header shows one
summary line: "3 now · 9 open · 3 closed today". "Activity history" stays at
the right.

Groups. The list has five groups in this order:

1. Now: codes, time-sensitive changes, and Albatross questions, approvals,
   and check-ins. These block something.
2. Today: obligations with `due` = `today`.
3. This week: obligations with `due` = `soon`. Items with `due` = `later` or
   `none` also sit here, after the dated ones (see open question 2).
4. Waiting on others: `kind` = `waiting`.
5. Closed today: every obligation closed since midnight. Collapsed by
   default. The header shows the count.

Row. Each row has four parts:

- Lead: initials for a person. A source glyph in a circle for a system
  (a bank, an airline, a pipeline, a Jira issue, a meeting). The Albatross
  source uses the Albatrosses rail glyph, never the bird.
- Name line: the asker in Fraunces 14 px, then the source as a small label
  ("Mail · Northwind Legal", "Slack · #release", "GitHub", "Granola").
- One line: what the user owes, 13 px, two lines at most.
- Meta: the time, the kind word, and "Draft ready" when a draft exists.
- Due column, right: the due day in tabular 11.5 px. Today is accent-3.
  Time-sensitive and expiry are accent-2. A closed reason is success.

Row states. Selected: the `selected-soft` background. Hover or focus: the
due column hides, and two pills take its slot: the primary action ("Send
reply", "Copy", "Start in Albatross") and "Done". Closed rows have 72 %
opacity and a muted line.

Code row. The code is in the row, in 22 px tabular type with wide letter
spacing. The row also shows "Sign-in code" and the expiry at the right. The
user does not need the detail for a code.

Detail. The detail has one shape for every kind: a source line (source,
asker, kind word, due day, time), the obligation as one sentence in 22 px,
"Why this needs you" with an accent-2 rule, a card with the source excerpt,
an optional accent card with the prepared step or draft, and the action row
at the bottom. The action row keeps the primary action first, then "Done",
"Later", "Not mine". One quiet line under the buttons says what the action
does ("Replies in the thread. Undo for 10 seconds.").

States of the page:

- Empty: the list shows one line, "Nothing needs you right now.", and the
  Closed today group if it has rows. The detail shows "You're caught up."
- While the data loads: five skeleton rows, as the Notifications page shows
  now. The summary says "Finding what needs you".
- Many items: the groups keep their order and the list scrolls. A group
  with more than 20 rows shows 20 and a "Show 12 more" line.
- Closed group: collapsed with its count. Enter or Space on the header opens
  it. Its rows show the close reason as the due word: "Done", "Used",
  "Expired", "Closed by itself", "Not mine".
- Error: the boundary copy of the Notifications page, with "Retry".

Keyboard. The list is one tab stop. Up and Down, or j and k, move the focus
between rows across groups. Home and End go to the first and last row.
Enter or Space opens the focused row in the detail. Escape moves the focus
from the detail back to the row. On a group header, Enter or Space toggles
the group. In the detail, Cmd+Enter runs the primary action.

Actions:

- Primary action: runs the prepared step. "Send reply" sends in the thread
  and the row closes as `done`. "Copy code" copies the code; the row stays
  open until the code is used or expires. "Start in Albatross" starts a run
  on the step with the source item as input and opens the thread; the row
  stays open until the run reports the step done. "Update calendar" writes
  the new time to the event. "Send follow-up" sends the follow-up mail; the
  wait stays open until the reply arrives.
- Done: closes the row as `done` at once. A toast offers "Undo" for 10
  seconds.
- Later: opens a small menu: "In 3 hours", "This evening", "Tomorrow
  morning", "Next week", "Pick a time". The row goes out of its group and
  comes back at that time, in-app only.
- Not mine: closes the row as `dismissed` and writes the Jev correction. A
  toast offers "Undo" for 10 seconds.
- "Open in Mail", "Open in Slack", "Open thread": quiet links. They open the
  source and change no state.

## Screen 2: mail reply

The source excerpt is a card, "From the mail", with the sender address and
"Open thread". The draft is an accent card, "Draft reply · To Dana
Whitfield", with "Edit" at the right. The draft text is a plain field. A
click on "Edit" or on the text makes it a text area in place; the card head
then says "Edited". "Send reply" sends the current text and uses the
current undo window.

## Screen 3: an item that belongs to an Albatross

The detail adds an Albatross card under the source excerpt: a status dot,
the Albatross title, and "Step 2 of 4 · Collect the numbers · Your turn",
with "Open thread". The primary action is "Start in Albatross". The quiet
line explains it: "Starts a run on step 2 with Priya's message as its
input."

## Screen 4: code

The detail shows the code in 44 px tabular type, a small ring that empties
with the time, "Expires in 8 min", and "Also in AutoFill on your iPhone".
"Copy code" is the primary action; the label becomes "Copied" for two
seconds. "Not mine" is the only other action. One line under the excerpt
says: "This closes itself when you use the code or when it expires." A code
never shows in the brief.

## Screen 5: the Albatross thread

An obligation with a `workId` is a message in the thread, in time order. It
is an accent-bordered card with: the kicker "Needs you", the source
("Slack · #release"), the time, the obligation sentence, the evidence line,
the quoted source message with the asker's avatar, and the actions. Inside
the thread the primary verb is "Handle it", the thread's own word, in place
of "Start in Albatross". "Open in Slack" sits at the right of the actions.
The thread rail row shows the status word "Your turn" and the preview
"Priya asked for the Q3 numbers".

## Screen 6: the Daily Brief region

The lane "Needs you" sits after the lede and before the Today lane. It uses
the accent lane (`surface-accent`), so it takes the place of the Answer
lane. The kicker shows the count sentence: "9 open · 3 now · 2 due
today". Now rows come first. A "Due today" sub-label separates the rest.
Each row uses the letter row: lead, asker in Fraunces, subject, one line,
and text actions (the first in accent, the second muted). The lane footer
is one sentence in the muted voice: "Closed by itself since yesterday's
letter." with the items. Items of kind `waiting` stay in the current
Waiting on lane.

## Screen 7: the rail and the toast

The bell badge shows the count of the Now group. It hides at zero. The
tooltip says "Needs you · 3 now". The bell opens the page, as now.

When the web app is open and an obligation passes the push bar, an in-app
toast shows at the bottom center: the asker's avatar, the sentence with
the asker in Fraunces, a source line ("Mail · Northwind Legal · a draft
reply is ready"), and two actions, "Open" and "Later". It hides after eight
seconds. A code toast shows the code and "Copy" instead.

## Screen 8: Settings, Notifications

The section keeps the settings card shape (`MailSettingsCard`). The "Push
for: Every new email / Priority only" select goes away. The rows are:

- "Push me when something needs me", a switch. Hint: "At most 4 pushes an
  hour, codes not included. More become one push."
- "Quiet hours", a switch and the From / To hour selects. The description
  says that codes and time-sensitive changes do not wait.
- "VIP senders", the chips and the add field. The description says that a
  VIP mail that needs nothing does not push.
- "Verification codes", a switch (`oneTimeCodeAutofillEnabled`).

A note under the card: "There is no setting for each new mail. Everything
open is on the Needs you page, pushed or not." A "Devices" card lists the
devices with push on. The aside shows "3 pushes today".

## Mobbin references

- Attio tasks, grouped by Today, This week, Upcoming, Completed, with due
  words in color: https://mobbin.com/screens/16b2e7b2-da40-4dc2-a63b-139c3078c1d9
- Asana task list with groups and a detail panel: https://mobbin.com/screens/95628ff8-7999-4c30-9820-5924b8fd9c59
- Lightfield tasks, grouped by Today, Tomorrow, No due date, with a detail
  panel: https://mobbin.com/screens/c1322cfa-763a-4f21-8b49-0062d3c40ed1
- Attio chat: a draft follow-up mail as a card, with a review line before
  the send: https://mobbin.com/screens/f56c62bf-1ca6-4fa5-bd1d-f9f0baf7cc52
- Rox: a draft email card inside an assistant thread: https://mobbin.com/screens/3d205a5d-5ead-4787-af2c-9b0a36ed2fc7
- Notion Mail: an inline draft with Accept and Discard: https://mobbin.com/screens/c76eb3bd-f70d-4235-baf4-f24c06421205
- Luma: code entry with a Paste code button and a resend timer: https://mobbin.com/screens/384ab3a5-b6e4-4667-a33c-e57774513349
- Hulu: a code with its expiry time in the copy: https://mobbin.com/screens/d1980564-5231-4b0c-8236-a1b3a51e5d43
- Slack preferences: a notification schedule with From and To hours: https://mobbin.com/screens/45df3d90-3518-44e7-9b17-e57cdbc84476
- Asana settings: Do not disturb with a schedule: https://mobbin.com/screens/426ad7e9-6572-4ad4-afbd-e4f4ee052ae2
- Linear settings, Notifications: channel rows with status lines: https://mobbin.com/screens/915c51c8-1e36-47d7-a8e9-a2c33bcc98f2

## Open questions

1. The prepared step for a `change`. The mockup offers "Update calendar"
   for the moved flight. The design has no prepared step for `change`, and
   calendar obligations are phase 4. Keep the step as a phase 4 item, or
   show "Done" as the primary action in phase 1.
2. Undated items. The design lists four open groups. Items with `due` =
   `later` or `none` have no group of their own. The mockup puts them at
   the end of This week. A fifth group, "Later", is the other option.
3. Albatross questions. The mockup shows "Answer" as the primary action.
   The detail can show the question's choices in place, with the current
   `WorkQuestions` form, so the user stays on the page.
4. "Done" on a reply with no sent reply (open question in the design). The
   mockup uses a 10-second undo toast and no second check.
5. Single-key actions in the detail (D for Done, L for Later, N for Not
   mine). The mockup does not show them. They are fast but easy to hit by
   mistake.
6. The brief. The Needs you lane and the current Answer lane overlap. The
   mockup replaces the Answer lane with the Needs you lane.
7. Calibration. The real `/dev/*-preview` routes did not render in the
   worktree: Turbopack rejects a `node_modules` symlink outside the project
   root, and the webpack fallback cannot build the PDF pane. The mockups
   follow the component code and the tokens, not a live render.
