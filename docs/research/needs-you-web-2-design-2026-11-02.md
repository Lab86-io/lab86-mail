# Needs you, round 2: where the owner does the work

Date: 2026-11-02. Status: built on `claude/needs-you-everywhere`. The design is
in `docs/needs-you.md`. The first web note is
`docs/research/needs-you-web-design-2026-10-30.md`. This note records what
changed in this round, and why.

## The problem

The Needs you page works, but it sits apart from the work. The owner asked:
"where does this appear in web???". The morning letter stores a copy of the
list, and that copy has no Done. A mail that owes a reply shows no sign of it
in the reader. An Albatross area shows a "Needs you" count that comes from a
different source, so the same words give a different number.

## Token plan

This is an existing product. Every value below is in `app/globals.css`.

- Color. `--color-accent` is the voice of Needs you: the kicker, the primary
  pill, the inbox mark, the calendar mark. `--color-accent-2` stays with
  time-sensitive items and "Why this needs you". `--color-accent-3` stays
  with "Today" and unread. `--color-success` says "Done" and "Closed by
  itself". No new color.
- Type. Fraunces (`font-display`) for the asker name, the head sentence of
  the Today list, and the thread title. Geist for the rows (13 px) and the
  controls. Tabular numerals in the due column (11.5 px).
- Radius. `--radius-ui` for every control. Full circles for avatars and
  status dots only.
- Row grammar. One row component, `NeedsYouRow`: lead, asker and source, one
  line, meta, due column; the hover pills (first action, Done, Later) take
  the due column's slot. Today, the page, and the previews share it.

## Layout

The Today list is the one place with a bold hierarchy choice. It is not a
card. It sits on the paper under the masthead and the source line, in the
measure of the letter, before the lede.

```
┌ masthead (picture frame, the date) ───────────────────────────┐
│ Written at 7:02 from your mail and calendar.                   │
│                                                                │
│ 3 things need you now. 2 more are due today.      (Fraunces)   │
│ ● Northwind Bank  Mail        482 913  Verification code  8 min│
│ ● Harbor Air      Mail        Flight HA 220 now ...    6:40 PM │
│ ● Dana Whitfield  Mail · NL   Asks you to confirm ...  Fri     │
│   ↳ Draft reply · To Dana Whitfield                 [Send reply]│
│ ● Priya Raman     Slack · #release  Asks for the Q3 ... Fri    │
│ 4 more are on the Needs you page.                              │
│                                                                │
│ The lede ...                                                   │
```

- The head is one sentence with the counts, not a label and a badge. The
  due column is the one indicator of each row. There are no group labels:
  the group order (Now, Today, This week, ...) and the due words carry it.
- The list shows at most six rows, Now and due today first. The foot is one
  plain sentence with a link to the page.
- A row that the user closes stays in place for the Undo window with the
  close word in the success voice and an Undo pill. Then it leaves with a
  height collapse. The collapse is the only motion: it shows what changed.
- Reply opens the prepared draft under the row, in place, with Send reply and
  Cancel. The draft comes from `POST /api/obligations/[id]/draft`.
- Albatross questions and approvals (the extras of the page) are rows too.
  Their one action opens the Albatross.
- When the live list shows, the stored lane of the brief (the letter region
  `needs-you` and the editorial module `needs-you`) does not render. Old
  editions and users outside the flag keep the stored lane.

Mail. One strip under the title bar of the reader: the lead, the obligation
sentence in Fraunces, "Why this needs you" in the muted voice, and the text
actions Draft reply, Done, Later at the right. In the inbox list, the thread
row gets one accent dot in the subject-line indent, under the unread dot. Two
statuses in one column: unread (accent-3, name line) and needs you (accent,
subject line). The row height does not change.

Albatrosses. The area brief's "Needs you" section merges the ledger items that
belong to an Albatross of the area. The chooser sentence now says "plans and
tasks", because that is what it counts. The thread rail row shows "Your turn"
and the item title when a thread has an open item. In the thread, the item
cards sit between the messages by time, through a `thread.extras` slot in the
chat.

Calendar. The event dialog shows the open `rsvp` or `prepare` item with Yes, No,
Maybe or Done, Later. The week and day block carries a small accent ring at
the right of the title when the event has an open item. The month badge does
not: it has no room.

Routes. `g n` opens the page. The palette lists "Needs you" and each open item
by title. The browser tab shows the Now count: "(3) Albatross".

## What the review against the brief changed

The first plan put the Today list in a `surface-accent` card with the lane
kicker "Needs you", the count at the right, and "View all" at the foot. That
is the generic widget. The built version has no card, no kicker label, and no
arrow: a serif sentence, the rows, and a plain sentence link. The first plan
removed a closed row at once and showed a toast. The built version keeps the
row for the Undo window, in place, because the page is the one place where
the user watches the list change.

## Mobbin: what was taken and what was refused

Taken:

- Notion Mail, the reminder strip above the message with its actions at the
  right (https://mobbin.com/screens/33009598-9ad3-434d-b9ef-6c4018a87c43).
  The reader strip follows this shape, with text buttons.
- Rox, the home that opens with "Here's your focus for today" and a list
  (https://mobbin.com/screens/62b4d10c-498e-49eb-bf78-3b944290f407). The
  head of the Today list is a sentence, not a label.
- Trello, "Up next" with Complete and Dismiss under the item
  (https://mobbin.com/screens/ff2054aa-0b09-4e08-8688-54491841bbce). Done in
  place, not in a detail.
- Linear, the snooze menu with named times
  (https://mobbin.com/screens/17c8ce50-57d6-4a36-aeba-700bcb563fc6). The
  existing Later menu stays; it now also shows on the row.
- Attio, tasks grouped by due date with the due word in color
  (https://mobbin.com/screens/5dab796d-b81b-4ac4-aa3a-f382b1682cb4). The due
  column is the one indicator.

Refused:

- Asana home, "My tasks" with Upcoming, Overdue, Completed tabs
  (https://mobbin.com/screens/b0321832-d38d-4fb4-8e16-3ea64ef390fa). Tabs
  hide the order; the groups are an order, not views.
- Wrike dashboard widgets with headers and counts
  (https://mobbin.com/screens/b453a329-6f1b-4745-ba03-5ce03c2c5307). The list
  is part of the letter, not a widget on a dashboard.
- Front, the snooze date picker
  (https://mobbin.com/screens/570723aa-6d10-4a00-935b-7ecb459c46a5). Three
  named times are enough.
- Salesforce, a floating to-do panel with star icons
  (https://mobbin.com/screens/74da9c3e-a4b8-4f50-bf42-a5b5ffd4aeb8). No stars,
  no floating panel.
- Proton, the orange "Event already ended" banner
  (https://mobbin.com/screens/331a296f-a5b6-4249-8800-63a5f9c1f84d). A closed
  item says its reason in the success voice, in the row.

## Previews

- `/dev/needs-you-preview?surface=today` (and `&state=empty`, `&state=long`)
- `/dev/needs-you-preview?surface=mail` (the reader strip and the inbox mark)
- `/dev/needs-you-preview?surface=calendar` (the event dialog and the block)
- `/dev/thread-preview?state=needsYou` (items between the messages)
- `/dev/brief-preview?layout=needs-you-editorial&live=1` (the live list over
  the brief, the stored lane hidden)
