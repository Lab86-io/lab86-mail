# iOS refresh: design plan, 2026-10-24

This plan is the brief for the iOS refresh round. It covers the chat, the
sidebar, and the other surfaces of the iOS app. The Mac target shares the
chat code, so the chat rules also apply to the Mac.

## The brief

- Subject: Albatross is a chief of staff for mail, calendar, tasks, and
  Work. It answers questions about these sources and it does work for the
  user.
- Audience: one busy person who reads on a phone between other tasks. The
  owner checks the taste closely. See the rules in "House rules" below.
- The primary job of the chat: ask about your own things, get an answer with
  its evidence, and hand work to Albatross.
- Owner request (2026-10-24): a full design pass on the iOS app, with the
  chat first; a refreshed app that shows the current features; a change to
  the sidebar riffle; and fixes for crashes and load problems.

## Baseline

The before images are in the `native-tour` artifact of Native acceptance run
38835187615 (commit `d4151b83`). The old defect list is
`docs/native-visual-review-2026-09-28.md`.

Problems in the current chat (iPhone, light):

1. Every reply has a "Hold this" line under it. The line repeats down the
   whole transcript.
2. The work log header is a meta string: "Did 1 thing · 1s". The left rule,
   the check rows, and the card inside the rule make three levels of chrome
   for one tool call.
3. Every card is a raised white card with a shadow. The user turn is also a
   raised white card. Evidence and the user's own words look the same.
4. The composer puts the clip, the field, the "Ask" chip, and send on one
   line. At AX3 the placeholder cuts to "Ask or h…" (D8).
5. The opening state is a generic greeting and four fixed suggestions. It
   does not know the user's day.
6. On iPad landscape the text runs to about 110 characters on a line (D23).
7. The jump control in the Work thread ("Newest") draws its label two times.

## Tokens

The palette belongs to the user (Settings, Appearance). The values below are
the default Forest palette. Code must read `ThemeStore`, never these hex
values.

### Color

| Name | Light | Dark | Use |
| --- | --- | --- | --- |
| Paper | `#F5F8F6` | `#080B09` | The page field. A cool, accent-tinted near white. |
| Inset | `#EFF2F0` | `#0E110F` | `subtleColor`. Evidence inserts in the transcript, wells. |
| Raised | `#FCFEFD` | `#151816` | `elevatedColor`. Sheets and real raised layers only. |
| Ink accent | `#216440` | `#84B595` | `accentColor`. Ask, links, the selected state. |
| Hold accent | `#853E19` | `#D6977B` | `accent2Color`. Hold and the run voice. Nothing else. |
| User turn | accent at 10 % (light), 16 % (dark) | | `accentSoftColor`. The user's own words. |
| Failure | system red | system red | `Color.red`. A failed work line and error text. Not a palette color, so a failure reads the same in every palette. |

### Type

| Role | Face | Size | Use |
| --- | --- | --- | --- |
| Display | User choice (Fraunces default) | 28–34 | Page titles, the chat opening sentence, H1 and H2 in replies, the sidebar title. |
| Display italic | Same family, italic | 15–17 | Datelines and machine narration: the work line in chat, "Updated 10 min ago". |
| Body | SF Pro, Dynamic Type `.body` | 17 | All reading text. Replies, user turns, rows. |
| Detail | SF Pro `.footnote` / `.caption` | 13 / 12 | Secondary lines and actions. Sentence case. |
| Figures | SF Pro, `.monospacedDigit()` | per role | Counts, times, money in inserts. |

Rules: no ALL CAPS labels, no tracked-out labels, no middle-dot meta strings
in new copy, no monospace for small labels.

### Radius ladder

Radius shows the level. Do not use one radius for every shape.

| Level | Radius | Shape |
| --- | --- | --- |
| Composer | 26, glass | The only glass object in the transcript. |
| User turn | 20, continuous | The user's message. |
| Insert | 12, continuous | Evidence, questions, approvals, forms. |
| Chip | 8 | Small controls inside an insert. |

There is no shadow inside the transcript. An insert is flat: Inset fill and a
hairline. `surfaceCard()` stays for sheets and real raised layers.

## Chat layout

### The opening state: "the desk"

The empty chat starts from the user's real day. This is the one bold element
of the round. Everything else in the chat stays quiet.

```
┌─────────────────────────────────────┐
│ ☰              New chat          ✎ ⟲│
│                                     │
│ Friday afternoon                    │  display italic, secondary
│ Priya and Sam wait on a reply.      │  display 30, up to 3 lines
│ Standup starts at 3:30.             │
│                                     │
│ Reply to Priya about invoice 2211   │  body, a real item
│ Priya Patel, 12:52 AM               │  footnote, its source
│ ─────────────────────────────────── │
│ Get ready for the venue walkthrough │
│ Today at 11:00 AM                   │
│ ─────────────────────────────────── │
│ What does Team offsite need from me?│
│ Area, 1 needs you                   │
│ ─────────────────────────────────── │
│                                     │
│ ╭─────────────────────────────────╮ │
│ │ Ask Albatross                   │ │
│ │ (+)        Ask │ Hold       (↑) │ │
│ ╰─────────────────────────────────╯ │
└─────────────────────────────────────┘
```

- The dateline comes from the clock: "Friday morning", "Friday afternoon",
  "Friday evening".
- The sentence comes from live store data, in this order: mail that waits on
  a reply (up to two names), the next event today, Work that needs the user.
  When the loaded data names no mail, event, or Work, the sentence is "What
  should Albatross take on?". A failed load does not change the desk; the
  page that failed shows its own error and Retry.
- Up to four rows. Each row is one real item and its source line. When there
  are fewer than four real items, fixed asks fill the list ("What needs my
  reply today?", "Walk me through my afternoon").
- A tap sends the row's ask. The rows are plain text with hairlines. No
  chips, no icons.
- Left aligned, 24 pt side margins.

### The transcript

```
                    ╭──────────────────────╮
                    │ How many people have │  accent-soft fill, r20
                    │ answered so far?     │  max width 80 %
                    ╰──────────────────────╯

Read 3 threads and the head count  ›         display italic 15, secondary
┌──────────────────────────────────────┐
│ Offsite head count                   │     insert: Inset fill, hairline, r12
│ 15            9            30        │     figures, accent ink
│ Confirmed     Waiting      Room limit│
└──────────────────────────────────────┘
Design and Sales answered with 15 people     body 17
together. Engineering has not answered.

Copy   Hold this                             footnote, last reply only
```

- The work line replaces "Did 1 thing · 1s". It is one sentence that names
  what Albatross did, from the tool rows ("Read 3 threads and the
  calendar"). A tap opens the rows. A failed row makes the line read "Could
  not read the calendar" in the Failure red.
- While a turn runs, the work line shows the current action in the present
  tense with three dots that pulse ("Reading Priya's thread"). There is no
  shimmer.
- Cards render under the work line, outside any rule. The left rule goes.
- "Copy" and "Hold this" show under the latest finished reply only. Every
  reply has a context menu with Copy, Hold this, and Share.
- Sources show as one footnote line of links under the reply.
- The text column has a maximum width of 680 pt and centers on wide screens.

### The composer

```
╭─────────────────────────────────────╮
│ In Team offsite                     │  caption, accent, only with a scope
│ Ask Albatross                       │  field, 1–6 lines, full width
│ (+)            Ask │ Hold       (↑) │  attach, route, send
╰─────────────────────────────────────╯
```

- Two rows. The field has the full width, so the placeholder fits at AX3.
- The route control shows both words. The selected word has a filled
  segment. A tap on either word selects it. Tab still flips it.
- The send circle is accent for Ask and Hold accent for Hold. It is the
  only solid, saturated fill in the chat. Tints at 10 to 16 % (the user
  turn, the selected route word) are not fills in this sense.
- Stop replaces send while a reply runs.
- Placeholder: "Ask Albatross" on Ask, "Hand this to Albatross" on Hold.

### The header and history

- The inline title is the conversation title (its first message, cut by
  `lineLimit(1)`), or "New chat".
- Trailing: New chat (`square.and.pencil`) and History (`clock`).
- History is a sheet with a search field and sections: Today, Yesterday,
  Earlier this week, Older. A row shows the title and the time.

### The Work thread

The Work thread uses the same message row and composer, so it gets the same
changes. The jump control becomes a small glass circle with a down arrow.

## The sidebar riffle

Owner request: the riffle must not select. It loads the page in the strip of
the page that shows at the side.

| Action | Result |
| --- | --- |
| Riffle, then the pick stays on a row for 0.18 s or the wheel stops | That row's page loads in the side strip. The sidebar stays open. A soft haptic. |
| Tap a row | That row's page loads in the side strip. The sidebar stays open. |
| Tap the row of the page that already shows | The sidebar closes on that page. |
| Tap the strip, or swipe left | The sidebar closes on the page that shows. |
| VoiceOver activates a row | The page loads and the sidebar closes, in one step. |
| Settings, New Area | No change. |

Also fix D6 (AX3 icon spacing) and D14 (the last row is cut with no sign
that the list continues). Add a fade at the bottom edge of the wheel.

## The other surfaces

The refresh applies the same tokens to every page. It does not invent a new
look for each page. Each page gets four kinds of work: the open defects from
`docs/native-visual-review-2026-09-28.md`, the crash and load fixes from the
audits, the feature gaps from the feature audit, and the shared rules below.

### Shared rules

- Page titles use the display face. A page with its own header uses
  `PageTitle` (`Core/Theme/Typography.swift`). Navigation bar large titles
  get the same face from `NavigationTitleAppearance`.
- One section header for the whole app: the short rule, the display-face
  heading, and the quiet hint. At accessibility text sizes the hint goes
  under the heading. It does not wrap in a narrow column beside it (D5).
- Nested content is an insert (flat, Inset fill, hairline, radius 12).
  `surfaceCard()` is for real raised layers only.
- Initials avatars use `@ScaledMetric` sizes and `minimumScaleFactor` on the
  initials, so AX3 never shows "…" (D3).
- Text in fixed columns (times, weekday letters, hour labels) gets a width
  that comes from the text, not a constant (D2, D10, D18).
- Every list or page that loads has three states: loaded, empty (an
  invitation to act), and failed (what went wrong and a Retry). A spinner
  never stays when the request has ended.
- Reading width: 680 pt maximum on wide screens (D23).
- Meta strings: no new middle-dot strings. Where a row joins two facts, use
  a comma or two lines.

### Open defects by page

| Page | Defects |
| --- | --- |
| Mail, thread, compose | D1, D3, D9 (search field over rows), D23, D26 |
| Calendar | D2, D7, D10, D11, D12, D17, D21 |
| Tasks | D22 |
| Today | D4, D15, D16, D18, D19, D20, D24 |
| Albatrosses (Work) | D5, D13, D25 |
| Sidebar | D6, D14 (done in this round by the lead) |
| Chat | D8, D23 (chat builder) |

## Principles

1. Albatross speaks in upright text. The machine narrates in italic. Each
   voice has one face.
2. Evidence is inset, not raised. No shadows in the transcript.
3. One solid, saturated fill for each screen: the send control. Soft tints
   of the accent do not count.
4. Actions show where the eye already is: the latest reply only.
5. The empty chat starts from the user's real day.
6. Text lines stay under 80 characters. Controls do not cut at AX3.

## Review against the brief

The generic default for an iOS assistant chat is a ChatGPT copy: a grey user
bubble, plain reply text, a centered "How can I help?", suggestion chips, and
a two-row composer. The plan keeps two of these on purpose: plain reply text
(it reads well) and the two-row composer (it fixes D8 at AX3).

Changes made after this review:

- The centered greeting became a dateline and a sentence from live data. A
  greeting says nothing about the user. The sentence says what waits.
- The suggestion chips became hairline rows of real items with their source.
  Chips are a template look, and fixed asks ignore the user's day.
- The meta string "Did 1 thing · 1s" became an italic sentence. The middle
  dot and the duration are template chrome; the sentence says what happened.
- The grey bubble became the accent-soft fill. It carries the user's own
  palette, so the chat changes with Settings, Appearance.
- The raised white cards became flat inserts. Identical shadowed cards are
  the SaaS card kit.

Check against the cream, serif, and terracotta default: the paper here is a
cool green-tinted near white from the user's palette, not `#F4F1EA`. The
Hold accent (brick in Forest) shows only on Hold and the run voice.

## House rules

- No star or sparkles icons. No icon before text on a button. Text-only
  buttons, except a functional glyph (attach, send, stop, the sidebar).
- No meaningless copy. Concrete verbs. Sentence case. No ALL CAPS labels.
- Do not repeat content that the same screen already shows.
- Never copy real owner data from screenshots into fixtures.
