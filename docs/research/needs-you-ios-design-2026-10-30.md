# Needs you: iOS design note

Date: 2026-10-30. Status: code in `apps/ios` (branch `claude/ny2-ios`).
The design is in `docs/needs-you.md`. The web note is
`docs/research/needs-you-web-design-2026-10-30.md`. This note records how
the phone translates the web page, and where the shared parts live.

## The brief

The subject is an inbox of obligations: what the user owes, and what the
user waits for. The audience is the owner, between two letters. The page
has one job: show what needs you, and let you act in one tap. Undo covers
a wrong tap.

## Tokens

- Color: every color comes from `ThemeStore`. The paper ladder
  (`paperColor`, `elevatedColor`, `subtleColor`) carries the surfaces. The
  accent is the first button, the selected row, and the draft card border.
  The second accent is the time-sensitive due word, the code expiry, and
  the "Why this needs you" rule. The third accent is a due word for today.
  A closed row uses the secondary text color at 72 percent opacity.
- Type: the asker and the detail sentence use the user's display face
  (Fraunces by default). The body uses the system text styles, so Dynamic
  Type applies. Codes and due words use tabular digits.
- Shape: the excerpt and the Albatross card are inset panels (14 pt). The
  draft is one raised card with an accent border. Nothing else is a card.

## Layout

The page is a list under the title "Needs you". One line under the title
says "3 now · 9 open · 3 closed today". The groups follow the web order:
Now, Today, This week, After this week, No due date, Waiting on others,
Closed today. Closed today is collapsed until a tap on its header.

```
┌──────────────────────────────┐
│ ≡  Needs you                 │
│ 3 now · 9 open · 3 closed    │
│ ── Now  3                    │
│ ◯ Northwind Bank  Mail  8 min│
│   482 913  Sign-in code  exp.│
│   11:03 AM · 2 min ago       │
│ ◯ Harbor Air  Mail  Today    │
│   Flight HA 220 now departs… │
│   9:12 AM · Time-sensitive   │
│ ── Today  2                  │
│ …                            │
│ ▸ Closed today  3            │
└──────────────────────────────┘
```

A row has four parts: the lead, the name line, one line about the item,
and the due word. The lead is initials for a person and a glyph in a
circle for a system. A code row shows the code in 22 pt tabular digits.
The user does not need the detail for a code. A swipe to the right marks
Done. A swipe to the left offers Not mine. A long press shows Done, Later,
Not mine, and Open in Mail.

The detail opens as a push. It has one shape for every kind:

1. The source line: source, place, asker, kind, due day. The time at the
   right.
2. The obligation as one sentence, 22 pt in the display face.
3. For a code: the code in 44 pt tabular digits, a ring that empties with
   the time, "Expires in 8 min.", and "Also in AutoFill on this device."
4. "Why this needs you", with a 2 pt rule in the second accent.
5. The source excerpt as an inset panel, with the address and "Open in
   Mail" (or "Open in Slack").
6. For a reply: the draft in an accent-bordered card. The text is a field
   from the start. The head says "Edited" once the words change.
7. The Albatross card, when the item belongs to one, with "Open thread".
8. The action row at the foot of the screen: the first button, then Done,
   Later, Not mine. Under it, "Start in Albatross" and the open link. One
   quiet line says what the action does.

The first button names the prepared step: "Send reply", "Copy code",
"Start in Albatross" (when the item has an Albatross), else "Done". An
invitation shows Yes, No, Maybe in its place. A code shows only "Copy
code" and "Not mine".

## States

- Loading: a spinner and "Finding what needs you".
- Empty: "Nothing needs you right now." and one line about what appears
  here. Closed today still shows under it.
- Error: "Couldn't read what needs you", the server's line, and "Try
  again".
- Undo: a material notice at the foot of the list, "Done: Dana Whitfield",
  with Undo and Dismiss. It goes after ten seconds.
- Copied: the first button says "Copied" for two seconds.

## Refresh

The list reads on open, on pull, on return to the app, and after a push.
A clock ticks every 30 seconds so the due words and the expiry stay true.
A code row leaves Now at its expiry without a read.

## Push

A phase 1 push names its mail thread, not the obligation. A tap on a push
keeps the thread keys beside the route. While the feature is on for the
user, the tap opens Needs you on that thread's item. When the list has no
item for the thread, the page opens the thread itself. A newer server can
send `type: "obligation"` and `obligationId`; the app reads both. The code
wake (`codeAvailable`) is not changed.

## Review against the defaults

The first plan had group headers in capitals and a card for each row. Both
are the generic list kit. The page now uses the app's ruled section header
and plain rows with hairlines. The one loud element is the code in large
tabular digits. Everything else stays quiet. No motion was added; the Undo
notice slides in because it answers a tap.

## Files

| Part | File | Target |
|---|---|---|
| Models and decode | `Lab86Mail/Core/Models/ObligationModels.swift` | iOS, Mac |
| Groups, clock, Later menu | `Lab86Mail/Core/Models/NeedsYouGrouping.swift` | iOS, Mac |
| Words | `Lab86Mail/Core/Models/NeedsYouLabels.swift` | iOS, Mac |
| Store and routes | `Lab86Mail/Core/Models/NeedsYouStore.swift` | iOS, Mac |
| Row and detail rules | `Lab86Mail/Features/NeedsYou/NeedsYouPresentation.swift` | iOS, Mac |
| Rows | `Lab86Mail/Features/NeedsYou/NeedsYouRow.swift` | iOS, Mac |
| The page | `Lab86Mail/Features/NeedsYou/NeedsYouView.swift` | iOS, Mac |
| The detail | `Lab86Mail/Features/NeedsYou/ObligationDetailView.swift` | iOS, Mac |
| Push keys | `Lab86Mail/Core/Notifications/NotificationResponseRouter.swift` | iOS, Mac |
| Tab and links | `Lab86Mail/Features/Shell/NavigationModel.swift` | iOS, Mac |
| Brief lane | `Lab86Mail/Features/Today/BriefDocument/BriefLetter.swift` | iOS, Mac |
