# Needs you: messages about the things you must do

Status: design, web first (2026-10-30). iOS and macOS come later.

## Goal

The app sends one message when something needs the user. It does not send a
message for each new mail. Each message comes from one source item: a mail, a
Slack message, a Jira issue, a Granola meeting, a GitHub or Bitbucket item, or
a calendar event. The message says what the user must do, and it gives a
prepared next step when one is possible.

OpenAI dots are the reference. A dot watches the connected apps, sends a
message when a decision needs the user, and keeps track of responsibilities.
In this app, the Albatrosses are the responsibilities and the Daily Brief is
the morning letter. This design adds the messages between the letters.

## Owner decisions (Jakob, 2026-10-30)

1. Obligation messages replace the per-mail pushes. The per-mail pushes stop.
2. One-time codes go through the same pipeline. The iOS AutoFill wake
   (`codeAvailable`) must continue to work.
3. Delivery is push and the app only. No Slack messages. No iMessage for now
   (Lab86 iMessage can come later).
4. Web first. iOS and macOS later.
5. Jev decides if an item needs a message.

### Second round (Jakob, 2026-10-30, after the mockups)

6. The mockups are approved. Build phase 1 on the web.
7. Items with a due date go first. The group order is: Now, Today, This
   week, After this week, No due date, Waiting on others, Closed today.
8. Done on a reply without a sent reply: no second check. Done closes the
   item at once and shows Undo for 10 seconds. The closed row says "Done, no
   reply sent". If the sender writes again, Jev assesses the thread again and
   a new item opens. Done is not a Jev correction; only Not mine is.
9. In the brief, the Needs you section takes the place of the Answer section
   (phase 3).

## Words

- **Obligation**: one thing that the user must do, or one thing that the user
  waits for. One source item can open more than one obligation (for example,
  reply and pay).
- **Needs you**: the label in the app for the open obligations.
- **Message**: the notice for one obligation. It can be a push, an in-app
  row, or both.

## Where obligations appear

| Surface | What it shows |
|---|---|
| Push | Only the obligations that pass the push bar (see below). One push for each obligation. |
| Needs you page (web) | All open obligations, with Albatross questions, approvals, and check-ins. This page replaces the Notifications page. |
| Albatross thread | An obligation with a `workId` also shows in the thread of that Albatross, as a message from the source. |
| Daily Brief | The brief reads the open obligations. It shows what is open, what is due today, and what closed by itself since the last edition. It does not search for obligations itself. |

## Sources

| Source | How an obligation opens | State today |
|---|---|---|
| Mail | Jev mail assessment: `reply`, `action`, `waiting`, `change` (`lib/jev/mail.ts`) | Jev runs; results feed the attention views and the brief |
| Slack, Atlassian, Granola, Google Drive | Content labels: `actionable`, `resolved`, `workId`, `kind` (`lib/content/intelligence.ts`) | Labels exist; only "Prepared for you" reads them |
| GitHub, Bitbucket | Content labels, after these sources join the content index | Synced every 20 minutes (`lib/mcp/sync.ts`); not classified. Must be added. |
| Calendar | An invitation without an answer; a meeting in the next 24 hours that needs preparation | Not built |
| One-time codes | The code extractor (`lib/mail/one-time-code-token.ts`, `lib/mail/urgent-detectors.ts`) | Built; it uses the urgent mail push |
| Albatross | Work questions, approvals, check-ins, step-run handoffs | Built; they show on the Notifications page |

## How Jev decides

Jev is a decision model. It answers typed questions with calibrated
probabilities. It does not write text. The decision has two parts.

### Part 1: Jev answers

Jev already answers these questions:

- Mail: `purpose`, `subject_kind` (includes `code`), `reply`, `action`,
  `waiting`, `change`, and the evidence message for each.
- Content: `kind`, `actionable` (for the owner), `resolved`, `workId`.

Add one question to both sets:

- `due` (choice): `today`, `soon` (in the next 3 days), `later`, `none`.
  "By the evidence, when must the owner act?"

Add one question for calendar events:

- `prepare` (noul): "Does the owner have to prepare something for this event
  before it starts?"

### Part 2: rules decide the message

The rules are code, not a model. Jev gives the probabilities; the rules use
the thresholds in `lib/classifier/catalog.ts`.

| Condition | Result |
|---|---|
| A one-time code | Push now. Never hold it. (See "Codes".) |
| `change` is high, and `subject_kind` is `finance`, `booking`, or `account` | Push now, time-sensitive. |
| `reply` or `action` is high, and the asker is a person, and (`due` is `today` or `soon`, or the sender is a VIP, or the item has a `workId` for an Albatross that the user used in the last 7 days) | Push now. |
| `reply` or `action` is high, and none of the above | In-app only. |
| Content `actionable` is high and `resolved` is low | The same rules as `reply` and `action`. |
| `waiting` is high | In-app only. Push one follow-up only when the due date goes by. |
| A probability in the uncertain band | No obligation. The brief can still show the item. |
| `purpose` is `promotion` or `newsletter` | Never an obligation. |

"High" starts at `noulHigh` (0.75 for Jev 1.13). Push needs a higher value,
0.85 to start. Tune both values with `scripts/eval-jev-mail.ts`.

### What Jev does not do

- **Speed.** Jev runs in a cron every 5 minutes, with a second stage for
  bodies. A message arrives 5 to 10 minutes after its source. This is correct
  for obligations, but not for codes. Codes keep the fast path.
- **Text.** Jev does not write the message or the draft. The message line
  comes from the source and the evidence message. A writer model makes a draft
  only for an obligation that passes the push bar, or when the user opens it.
- **The whole day.** Jev reads one item at a time. The rules, not Jev, compare
  an item with the rest of the user's day.

## Lifecycle

| State | Cause |
|---|---|
| `open` | Jev or the code extractor opens it. |
| `snoozed` | The user selects Later. It opens again at the selected time, in-app only. |
| `done` | The user marks it done, or the app sees the user's action (a sent reply, a sent Slack reply, a merged review). |
| `resolved` | The evidence closes it: Jev `resolved`, a new assessment with `reply` low, a cancelled event. |
| `dismissed` | The user selects Not mine. This writes a scoped Jev correction (`correctionForMail` in `lib/jev/contract.ts`). |
| `expired` | A code after its expiry time. A calendar obligation after the event starts. |

One obligation for each source item and kind. When the source changes, the
same obligation changes. The push uses the obligation id as the
`apns-collapse-id`, so a change replaces the old push and does not add a new
one.

## Delivery rules

- One push for each obligation. A change updates the same push.
- Quiet hours stay. Pushes wait until quiet hours end, except codes and
  time-sensitive changes.
- VIP senders stay. A VIP sender's obligation passes the push bar. A VIP
  sender's mail without an obligation does not push.
- A limit of 4 pushes each hour, codes not included. More pushes become one
  push: "3 more things need you."
- The `mail_message` writer stops. The new-mail digest stops.
- `urgent_mail` becomes an obligation with the time-sensitive level.

## Codes

A code is an obligation of kind `code`.

- The code extractor stays deterministic and runs at ingest, as now.
- The push goes at once with `codeAvailable: true`. The iOS app wakes and puts
  the code into AutoFill (`OneTimeCodeCoordinator`, `Lab86MailAutoFill`).
- Quiet hours do not hold a code. Today a code that arrives in quiet hours is
  held, and the held push has no `codeAvailable` flag, so the code does not go
  into AutoFill in time. This design fixes that defect.
- The obligation closes when the AutoFill extension consumes the code, or when
  it expires. The mail cleanup stays (`lib/mail/one-time-code-cleanup.ts`).
- The setting "Verification codes" (`oneTimeCodeAutofillEnabled`) stays.

## Web surfaces (for the mockups)

1. **Needs you page.** It replaces the Notifications page. A list with a
   detail panel. Groups, in this order: Now, Today, This week, After this
   week, No due date, Waiting on others. A closed group ("Closed today") is
   collapsed at the end. Items with a due date always come before items
   without one. Each row shows who asked,
   the source, one line about what the user owes, the time, and the due day.
2. **Detail: mail reply.** The source excerpt, the evidence line ("Why this
   needs you"), a prepared draft that the user can edit, and the actions: Send,
   Not mine, Later, Done.
3. **Detail: an item from Slack, Jira, or Granola that belongs to an
   Albatross.** The Albatross link, and the action "Start in Albatross", which
   starts a run with this item as its input.
4. **Code row.** The code in large type, Copy, the service name, the time to
   expiry. The row closes itself when the code is used.
5. **Albatross thread.** An obligation message inside the Work thread, with
   the source and the same actions.
6. **Daily Brief region.** "Needs you" near the top: the open count, the items
   due today, and the items that closed by themselves since the last edition.
7. **Rail.** The bell count is the count of open obligations in the Now group,
   not unread mail.
8. **Settings, Notifications.** "Push me when something needs me", quiet
   hours, VIP senders, "Verification codes". No per-mail push setting.

### Rules for copy and visuals

- Never write "AI" in user copy.
- No star or sparkle icons. No icon before text in a button. No ALL-CAPS
  labels. Sentence case.
- The copy names the action: "Send reply", not "Apply".
- Use only invented people, companies, and places in fixtures and mockups.
  Never copy real mail or screenshots of the owner's data.

## Data

New Convex table `obligations`:

- `userId`, `kind` (`reply`, `action`, `waiting`, `change`, `code`,
  `prepare`, `rsvp`), `state`, `source` (`mail`, `slack`, `atlassian`,
  `granola`, `github`, `bitbucket`, `drive`, `calendar`, `albatross`),
  `sourceKey` (the content item key or thread key), `title` (one line),
  `asker`, `due`, `dueAt`, `workId`, `probability`, `pushLevel` (`none`,
  `normal`, `time_sensitive`), `pushedAt`, `notificationId`, `draftId`,
  `openedAt`, `closedAt`, `closeReason`, `createdAt`, `updatedAt`.
- Indexes: by user and state; by user and source key; by user and work.
- Add the table to `deleteUserCascade` in `convex/accounts.ts` and to the data
  export.

The `albatrossNotifications` table gets a type `obligation` that points to the
obligation row. The in-app list reads the obligations, not the notification
rows.

## Cost

- Jev already classifies each item. One more question adds a few tokens to
  each call. Jev costs about $0.07 each day now.
- Drafts use the premium writer only for obligations that pass the push bar,
  or when the user opens one.

## Phases

1. Ledger and mail: the `obligations` table, the `due` question, the rules,
   codes through the ledger, stop the per-mail pushes, the web Needs you page.
2. Content sources: Slack, Atlassian, Granola, and Drive through the ledger;
   add GitHub and Bitbucket to the content index.
3. Albatross and brief: obligation messages in Albatross threads; the brief
   reads the ledger.
4. Calendar obligations.
5. iOS and macOS.

## Open questions

- The push limit (4 each hour) and the push threshold (0.85) are first values.
  Check them after one week of real use.
- Closed: "Done" without a sent reply uses Undo, not a second check
  (decision 8).
