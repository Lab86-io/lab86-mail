# The live Today page

Date: 2026-11-04. Status: built on `claude/today-live`, for users in `LAB86_NEEDS_YOU`.

## Owner decisions

The owner said that they avoid the old page. They decided these points on 2026-11-04:

- Today is a live page, not a morning paper.
- There are no long stories on the page.
- The art stays big.
- The order is: date and art, a short note, Needs you, the day's schedule, at most two short facts.

## What changed

- **No editor run for a user on this page.** `composeDailyBrief` skips the editorial agent for a flag user and runs `writeWorthKnowing` instead. Past editions keep their letter, and users outside the flag keep the old page.
- **The note is code, not a model.** `todayNote` (`lib/obligations/today-page.ts`) reads the same ledger and calendar as the sections under it, so it cannot go stale or say what they do not show.
- **Rows.** `todayRows` puts the notices of one sender in one row. Done, Later, and Undo act on all of them. Due now and today come first. After that, a question from a person comes before a notice.
- **Ledger rules, version 3.** A GitHub or Bitbucket item needs an owner fact (review, mention, assignment, failed check), so the owner's own pull requests no longer open items. Headings and Markdown marks leave row lines. A stored address reads as a name. The repair applies this to open rows.
- **Schedule.** `calendarData:myDayEvents` gives the live day. `scheduleLines` gives each event its state and marks free time of an hour or more.

## The page

```
┌ frame (slim moulding) ─────────────────────────────────────┐
│ painting in true color, 34% of the viewport height at most │
│ Wednesday, October 28                                      │
└────────────────────────────────────────────────────────────┘
Credit line, 12 px

8 things need you. First, an urgent notice from Harbor Air.     display, 28 px
Design review ends at 11:30 AM. Lunch with Mara is next.        sans, 16 px, muted

Needs you                 View all 8 │ Schedule     Open calendar
────────────────────────────────────  ─────────────────────────
Harbor Air [Urgent]  [Read] Done Later  9:30 AM  Team standup
Flight HA 220 now departs...            Now      Design review (filled)
────────────────────────────────────    Next     Lunch with Mara
Priya Raman  repo #491  Due today       Free until 3 PM ────────
Review: Move the invoice...             Worth knowing
```

Below a width of 860 px the columns stack. Below 560 px, the actions sit under the text of the row.

## Row rules

- Only the first row has the solid primary action. Other primary actions have a tinted fill and a border.
- Done, Decline, and Later are text until the pointer is on them.
- The first action of each row has a word from fixed rules: Reply, Open draft (a draft is ready), Accept, Copy, Review (the title starts with "Review"), Read (mail), Open (other sources).
- Actions sit in three fixed columns, so they line up from row to row.
- The sender line holds the name, the place, and the status: "Due today", "Due Friday", "Starts tomorrow 1:05 PM", or the Urgent tag.
- A source badge shows on the avatar only for items that are not mail.

## How the design was scored

The method comes from the video "Agents Sucked At UI (Until Today)" (Theo, t3.gg). Fresh reviewers score screenshots out of 10 against other products, and each round fixes what they name. They do not know any target score. Reference screens came from Mobbin: Tana, Attio, Superhuman, Notion, Joi. All screenshots use invented data from `lib/obligations/today-fixtures.ts`, through the real components at `/dev/today-preview`.

Fixed rules limit some reviewer requests. The note and the button words cannot say "flight" or "NDA", because no code knows that an item is one. The owner's decision on art size also holds: the frame height changed only by a small amount, and only on short screens.
