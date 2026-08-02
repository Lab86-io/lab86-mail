# Albatross north-star UX audit

Date: 2026-08-01
Scope: the web client (`app/`, `components/`). The iOS client follows the same
map after round 3.
Method: I read the router and the surfaces, then I ran the app and looked at it.
A local dev server on `:18838` with `LAB86_ENABLE_ALBATROSS=1`, a headless
Chromium over the DevTools pipe, a real Clerk session, and screenshots of every
top-level surface. The taste findings below come from the pictures, not the
source.

Goal: make the product one app. Today it renders as four.

---

## 1. What the running app looks like

### 1.1 The first screen is a mailbox request

A new account never reaches the product. `FirstRunRedirect`
(`components/hosted/HostedOnboarding.tsx:54`) sends every user with no connected
mailbox to `/welcome`, on every load of `/`.

That screen says **"Welcome to Lab86 Mail"**, then asks for two things:

1. Connect your mail — Gmail, Microsoft, iCloud.
2. Choose how AI runs — provider, normal model, fast model.

It prints `GPT-5.5 · 1M context · $5.00/M in, $30.00/M out` before the user has
told the product anything. The north star says the promise comes first and the
connection request comes second, scoped to the first outcome. Today the order is
exactly reversed, and the second step is a model-pricing table.

The gate is also wrong in kind. The product's promise is *tell me what is
weighing on you*. The lock on the door is *connect a mailbox*.

### 1.2 The rail

Live text, read out of the DOM:

```
Lab86 Mail
Compose            c
Daily Report
Calendar
Tasks
Files
ALBATROSS
  Set up areas
SMART
  Main
  Codes
  Orders
  Noise
MAIL  >
  Choose accounts
```

Findings:

- The title is **Lab86 Mail**, with `Lab86` in accent green.
- The loudest object on the screen is a dark green **Compose** pill.
- **`ALBATROSS` is a folder heading whose only child is `Set up areas`.** The
  product name labels a configuration chore.
- `SMART`, `MAIL` and `ALBATROSS` are upper-case letterspaced micro-labels. The
  house rules ban that pattern. It appears **54 times across 19 files**; the
  worst are `DailyReport.tsx` (11), `Rail.tsx` (7) and `WorkDetail.tsx` (7).
- A gear icon sits inside the `SMART` group label. Configuration is inside
  navigation.

### 1.3 Mail

The mail surface with no connected account shows **eight grey skeleton rows that
never resolve**. There is no empty state. A first-time user sees a permanent
loading screen.

The search placeholder reads: *Ask for mail or type search filters, e.g. "order
updates from this week"*. It teaches two mental models in one line — ask a
question, or write filter syntax.

### 1.4 Daily Report — the most beautiful wrong screen in the product

The brief renders as a magazine. A full-bleed Salvator Rosa oil painting, a
masthead in display serif — **"The Wednesday Brief"** — a monospace museum
credit, and a pill reading *Manual edition*.

What is wrong with it:

1. **It is 24 days stale and says nothing about that.** The masthead date reads
   `Jul 08, 2026`. Today is August 1. The strip above it reads *"Live · updates
   without regenerating the brief"*. A stale document labels itself Live.
2. **The one line that needs the user is the smallest text on the page.**
   *"3 Work questions need you"* renders at roughly 12px, muted grey, above the
   masthead. Below it, a 400px-tall painting. The hierarchy is inverted.
3. **The largest data graphic in the whole product is a seven-day temperature
   chart.** Weather carries no responsibility. It occupies the entire second
   screen.
4. Invented section vocabulary: *Quiet bulletin*, *Main tension*. Neither names
   a thing the user can act on.
5. The lead headline was *"A clean desk, with the weather doing most of the…"* —
   the brief writes a newspaper about a day with no obligations in it.
6. Three type systems on one screen: display serif masthead, monospace credit,
   sans body.

This screen is the clearest artifact of the daily-brief iteration. It is built
to be admired, not acted on.

### 1.5 Areas — where the real work is hidden

With Albatross enabled and no areas configured, the surface reads:

> Areas · 0 active
> No areas yet. Set up the parts of your life you are responsible for and the
> **classifier** starts sorting mail, events, and tasks against them.
> [ Set up areas ]                                          Manage

Then, in the bottom-right corner, a floating card:

> **ALBATROSS NEEDS ONE THING**
> What total dollar amount do you want to put into g…            ⌄

And the notification popover behind it holds three real questions about a real
albatross:

- *What total dollar amount do you want to put into gold? (This sets each half —
  e.g. $10k total = ~$5k ETF + ~$5k physical.)*
- *Which local dealer should handle the physical half?*
- *Do you want to buy it all at once, or spread purchases over a few months?*
- each tagged *Set up a gold allocation: half ETF, half physical*

**This is the whole problem in one screenshot.** The main pane says `0 active`
and *No areas yet*. The product is in fact carrying a live, well-reasoned,
multi-step financial task, and it is asking three good questions about it. None
of that is reachable from any page. It lives in a popover and a truncated
floating card.

Two further defects visible in that same frame:

- The same question renders **twice at once**, in the popover and in the
  floating card, and the floating copy is cut mid-word with an ellipsis, so it
  cannot be answered from where it is shown.
- The word **classifier** appears in the primary empty state.

### 1.6 The primary button has no fixed name

The capture launcher animates its own label. In one screenshot it reads
**New Idea**; seconds later, **New Work**. Its accessible text is `New Idea\nNew
Work`. It also carries a small gradient orb glyph before the text, which the
house rules ban.

An albatross is not an idea, and it is not work. The front door of the product
does not know what it is called.

### 1.7 The capture sheet is the best screen in the product

Open it and everything improves:

> **What are you trying to get out of your head?**
> *the thing you keep carrying around…*
> ( mic )  [ Get it out ]
> Text / Cmd+Enter to save / Esc to close

Calm, centred, one question, a voice path, honest keyboard hints. This is
already close to the north-star capture. Keep it almost as-is. The only defect
is that the door and the room use different words.

### 1.8 Tasks is a different product

A Trello board: `TODAY · THIS WEEK · BACKLOG · DONE`, upper-case column heads,
`+ Column`, `Add card`, a `Personal` board chip, and a **Share** button. Share
implies collaboration, which the product does not have and does not want yet.

It also creates a second Today. A kanban column named TODAY will compete with
the Today surface the moment that surface exists.

### 1.9 Calendar

Honest and clean: *No calendars synced yet · Connect an account in Settings, or
wait a moment while the first sync completes.* One event style only — there is
no visual difference between a flight and an intention.

### 1.10 Settings

Header: **Settings · Your mailboxes, your models, your rules.** Back link:
**Back to inbox** — the app states that its home is the inbox. Tabs: Mailboxes ·
Connections · Areas · Sending · Notifications · **AI** · Shortcuts · Account.

`AI` is a user-facing tab name, and `your models` is user-facing copy. Both break
the positioning rule.

### 1.11 The bottom-right corner is crowded

At one moment the corner held: the truncated question card, the New Work pill,
and (with Albatross off) an `Ask Assistant ⌘K` pill. The bottom-left held a
notification bell with a red `3`, a palette button, and the framework's dev
badge. Four floating entry points, no hierarchy between them.

---

## 2. What the code is

### 2.1 Routed surfaces

`components/shell/AppShell.tsx:351` is the entire router. Seven views.

| View | Rail label | Component | Lines | Reachable |
|---|---|---|---|---|
| `mail` (default) | none — reached through mailbox rows | `Inbox` | 1720 | yes |
| `daily_report` | Daily Report | `DailyReport` | 2443 | yes |
| `calendar` | Calendar | `CalendarSurface` | 433 | yes |
| `tasks` | Tasks | `TasksSurface` | 2612 | yes |
| `files` | Files | `FilesSurface` | 1453 | yes |
| `areas` | live area rows | `AreaHome` / `WorkDetail` | 2707 / 472 | yes |
| `unassigned` | none | `AlbatrossSurface` | — | deep link only |
| `intents` | none | redirects to `areas` | — | dead route |

### 2.2 About 6800 lines of unreachable surface

- **`PlansSurface.tsx` — 1999 lines.** Capture, interpretation, questions, the
  plan, approvals, apply. The shell never mounts it. The only path in is the
  picture-in-picture window, through `AlbatrossCompanion.tsx:166`. The best plan
  UI in the repository has no front door.
- **`IntentsSurface` and `AreasSurface`** inside `AlbatrossSurfaces.tsx` (4500
  lines). The comment at line 129 says it: *"no longer routed by the shell"*.
- **`AreasLive.tsx` — 335 lines.** No importer anywhere.

### 2.3 A feature flag hides half the product

`LAB86_ENABLE_ALBATROSS` (`lib/hosted/controls.ts:27`) gates it. With the flag
off, `?view=areas` silently renders the Daily Report — `PrimarySurface` falls
through to `<DailyReport />`. The user asks for one thing and gets a magazine,
with no message.

### 2.4 The four apps, named

1. **A mail client.** Compose is primary. Mailboxes, smart labels, snooze, trash,
   account filter.
2. **A productivity suite.** Daily Report, Calendar, Tasks, Files as equal peers.
3. **An area knowledge system.** Areas, facts, candidates, teach flows, reindex,
   an Unassigned review queue.
4. **An intent engine.** Capture, plan, questions, approvals, apply, evidence.
   The actual product. The one with no navigation.

---

## 3. The noise catalogue

These are cross-surface defects. No single file is wrong; the set is wrong.

### 3.1 Internal machinery in user copy

| String | Location | Problem |
|---|---|---|
| "the **classifier** starts sorting mail" | Areas empty state | Names the mechanism, not the benefit |
| "**{n} verified**" badge | `AreaHome.tsx:466` | A count of internal fact rows, shown as a life fact |
| "Linked: **{n} artifacts**" | `AlbatrossSurfaces.tsx:542` | Engineer noun |
| "**{n}%**" confidence badge | `Inbox.tsx:1429` | Raw model score in the mail list |
| "**high / medium / low confidence**" | `AreaOnboarding.tsx:639` | Same idea, second format |
| "**High / Medium / Low confidence**" | `AlbatrossSurfaces.tsx:212` | Same idea, third format |
| "**Candidate** / **Verified** / **Rejected**" | `AlbatrossSurfaces.tsx:158` | Pipeline states as user vocabulary |
| "your **models**", tab "**AI**" | Settings | Breaks the positioning rule |
| "**Unassigned**" | route + review queue | Names a queue, not a need |

Jakob named this one directly: the area surfaces report how well grounded an area
is. That number is a property of the index, not of the user's life. **Machine
confidence should never appear as a number.** If confidence is low, the product
asks a question or says nothing. It does not publish a score.

### 3.2 One idea, several implementations

| Idea | Implementations |
|---|---|
| Answer a question | `QuestionsSection`/`QuestionRow` (`AlbatrossSurfaces.tsx:1596`) **and** `WorkQuestionCard` (`WorkDetail.tsx:385`) |
| Confidence label | three formats, listed above |
| The pending question | the notification popover **and** the floating card, at the same time, one truncated |
| Today | the `TODAY` kanban column **and** the future Today surface |
| Capture entry | `IntentCaptureLauncher`, `AIBarTrigger`, `AlbatrossCompanion`, `SuggestionsTray` |

### 3.3 Contradictions on one screen

- *"Live · updates without regenerating the brief"* over a brief dated 24 days
  ago.
- *"Areas · 0 active"* and *"No areas yet"* while three live questions about an
  active albatross wait in a popover.
- A question shown in a card too narrow to finish the sentence, next to a
  disclosure chevron that is the only way to read the rest.

### 3.4 Style drift

54 upper-case micro-labels across 19 files, against a written house rule. Three
type systems in the brief. Two icon styles — animated `lucide-animated` rail
icons and static lucide icons elsewhere. `ShineBorder` on the active rail row and
the Compose button, nowhere else.

---

## 4. The target map

### 4.1 Sidebar

```
Albatross
by Lab86

[ Get this off my mind ]        <- primary, accent, always first

Today
Albatrosses          (word badge only, e.g. "2 need you")
Mail
Calendar
Files

Areas
  Work
  Money
  Home
  …
  + New area

Search
Activity
Settings
```

Rules:

- No number badge beside Albatrosses. A count of open albatrosses is a count of
  weights. Use words: `Needs you`, `One decision`, `Proof arrived`.
- Compose leaves the rail. It belongs inside Mail.
- Mailboxes and smart categories leave the rail. They become a filter row inside
  Mail.
- `Tasks` leaves the rail.
- Group labels are sentence case.
- One floating control in the corner, not four.

### 4.2 Route table

| Old view | New view | Action |
|---|---|---|
| `mail` | `mail` | keep, restyle the header, add a real empty state |
| `daily_report` | `today` | rename, rebuild the content |
| `calendar` | `calendar` | keep, split fixed from flexible |
| `tasks` | — | hide behind a setting, keep the code |
| `files` | `files` | keep, demote in the rail order |
| `areas` | `areas` | keep as the Area page only |
| `areas` + `selectedWorkId` | `albatross/:id` | promote to a real view |
| — | `albatrosses` | new: the state list |
| `unassigned` | filter inside `albatrosses` | delete the view |
| `intents` | delete | dead |

`lib/shared/types.ts:151` holds the enum. Persisted views must map forward so no
user lands on a blank pane.

### 4.3 Kill the flag

`LAB86_ENABLE_ALBATROSS` must go. A product cannot have its centre behind an
environment variable that silently falls back to a magazine.

---

## 5. Flow map

`NEW` marks work that does not exist. `MOVE` marks code in the wrong place.

### F1 — Capture
Entry: the primary rail button, `c`, mobile centre action, share sheet, voice, a
selected thread, a text selection.
State: `IntentCapture.tsx` is good. Keep the sheet.
Gap: the launcher label must stop animating and read **Get this off my mind**.
Add the entry points beyond the launcher.

### F2 — Interpretation
Shows: what I think you want · what I found · suggested classification ·
suggested next move. Controls: `Start` · `Correct this` · `Add context` ·
`Not now`.
State: `PlansSurface.tsx` renders nearly all of it, unreachable.
Gap: `MOVE` it into the shell as the Albatross detail. `Correct this` must edit
the interpretation without a plan rebuild.

### F3 — Answer a question
One question at a time, options where real choices exist, free text always. The
plan updates in place.
State: two implementations. **Neither is reachable from a page** — the live
questions only surfaced in a popover.
Gap: keep one, put it on the detail page and in Today.

### F4 — Approve an action
The card must show the action, the sending identity, the recipient, the
attachment, and the related Albatross.
State: `ApprovalsSection` (`AlbatrossSurfaces.tsx:2114`) plus
`components/tool-ui/approval-card`.
Gap: the identity line is not guaranteed. This is the trust surface. Make it
exact.

### F5 — Guided browser step `NEW`
Two panes: the step on the left, the site on the right. Modes: `Guide me` ·
`Do it with me` · `Handle it`. Failure: `Let me take over` · `Try another route`
· `Explain what I see` · `Save progress`.
State: none. Round 5. The shell already has the two-pane layout, so the cost is
the pane content.

### F6 — Evidence and close
Header ribbon: **Outcome · Next move · Last proof**. Evidence card: claim,
source, observed facts, confidence, limits. Closure levels: `Action succeeded` →
`Outcome likely` → `Outcome confirmed`.
State: `convex/albatrossEvidence.ts`, and a chip row at
`AlbatrossSurfaces.tsx:343` that shows a source, not a claim.
Gap: the claim-based card. This is the centre of the product.

### F7 — Lapse and recovery `NEW`
Nothing turns red. *This block passed. What should happen now?* Reasons: no
energy · no time · something came first · blocked · need help · the step was too
large · this matters less now · I forgot. Responses: `Move` · `Shrink` · `Wait` ·
`Delegate` · `Pause` · `Release` · `Rebuild`.
State: none, and no table behind it.

### F8 — Release `NEW`
*Put this down?* with a reason, an optional review date, an optional note. Shown
as a success, in the same visual family as completion.
State: none. `archived` is the only near value.

### F9 — Staleness review `NEW`
A batch card: *These four have not moved in a while. Which still deserve space?*
Per row: `Keep` · `Pause until…` · `Change the outcome` · `Release`.
State: none.

### F10 — Mail creates an Albatross
An inline strip inside the thread: *This email appears to create a
responsibility.* Controls: `Create Albatross` · `Attach to existing` · `Ignore` ·
`Never suggest this type`.
State: `SuggestionsTray.tsx` is close in spirit but lives in the shell.
Gap: move the offer next to the mail that caused it.

### F11 — Mail carries proof `NEW`
*This looks like proof for "Renew passport".* Controls: `Use as proof` ·
`Not related`.
State: none. The strongest single feature in the product.

### F12 — Calendar, fixed against flexible
Fixed: solid fill, full border. Flexible: soft fill, dashed border, named by its
Albatross. A missed flexible block routes to F7; a missed fixed event asks *Did
this happen?*
State: one event style.

### F13 — Area page
Area brief at the top, then tabs: Brief · Albatrosses · Mail · Calendar · Files ·
People · History.
State: two tabs, Brief and Inbox (`AreaHome.tsx:862`).
Gap: the Albatrosses tab matters most. Remove the `{n} verified` badge.

### F14 — Files as outputs
A file opened from an Albatross shows *Connected to: <outcome>*.
State: `FilesSurface` and `DocumentEditor` are strong. The connection line is
missing.

### F15 — Re-entry after absence `NEW`
*Welcome back. A lot may have changed.* Options: `Show only urgent` · `Keep what
still matters` · `Pause the rest` · `Rebuild this week` · `Review one area`. No
list of overdue work, ever.

### F16 — Onboarding
*What is one thing you keep meaning to handle?* → connect only what that outcome
needs → show the interpretation → produce the plan → finish one real step.
State: reversed. Accounts and model pricing first, under the name Lab86 Mail.
Gap: invert it, and stop blocking the app on a connected mailbox.

### F17 — Evening check-in
State: `DailyCheckin.tsx` exists and is wired to notifications and the report.
Gap: the answers must visibly change tomorrow's plan. That link is not shown.

### F18 — Search
State: `CommandPalette.tsx` searches mail.
Gap: it must search albatrosses, evidence, files and people.

### F19 — Activity `NEW`
One page: what happened, which account acted, what was accessed, what changed,
what was approved, what can be undone.

---

## 6. Delete or hide

| Item | Verdict | Reason |
|---|---|---|
| `TasksSurface` kanban, column drag, list mode | Hide behind a setting | The user must not maintain a board. Keep the code as an optional project view. |
| The `Share` button on the board | Delete | The product has no collaboration. |
| `ProjectsLens` | Hide with it | Same reason. |
| `AlbatrossSurfaces.IntentsSurface` | Delete | Unreachable; superseded by `PlansSurface`. |
| `AlbatrossSurfaces.AreasSurface` | Delete | Unreachable; superseded by `AreaHome`. |
| `AreasLive.tsx` | Delete | No importer. |
| `unassigned` view | Delete the view | Becomes a filter inside Albatrosses. |
| `intents` view | Delete | Dead redirect. |
| `LAB86_ENABLE_ALBATROSS` | Delete | The product cannot be optional. |
| Rail mailbox rows (ten) | Move into Mail | The rail is not a folder tree. |
| Rail smart categories | Move into Mail | Same. |
| Rail Compose button | Move into Mail | The primary action is capture. |
| Smart-label settings gear in the rail | Move to Settings | Configuration is not navigation. |
| The floating truncated question card | Delete | The popover already holds it, and Today will hold it properly. |
| Picture-in-picture companion | Hide behind a setting | A fifth app while Today does not exist. |
| `AIBarTrigger` | Delete the button | Already hidden when Albatross is on. |
| Weather chart in the brief | Cut to one line | It carries no responsibility. |
| "Quiet bulletin" / "Main tension" | Delete | Invented vocabulary. |
| Fact confirmation as a chore | Restrict | Facts appear inside the Albatross that uses them, never as a queue. |
| Every confidence score in user copy | Delete | Ask a question or say nothing. |

Only the two view renames need a data change.

---

## 7. Visual language

1. **Type.** The editorial serif carries outcomes and headings. The sans carries
   controls and data. No third family. The monospace museum credit goes.
2. **No upper-case micro-labels.** 54 occurrences to remove.
3. **State by shape, not colour.** Fixed is solid. Flexible is dashed. Waiting is
   flat. Needs-you is raised. Red is for errors only.
4. **The three-fact ribbon.** Every Albatross opens with Outcome, Next move, Last
   proof, on one line. Reference: the Squarespace project header — three facts,
   no chart. <https://mobbin.com/screens/41d2a034-ddc0-4eba-8907-306131b3c388>
5. **Today is two columns, not a dashboard.** Left: what needs the user. Right:
   the schedule. Reference: the Rox home screen.
   <https://mobbin.com/screens/62b4d10c-498e-49eb-bf78-3b944290f407>
6. **Hierarchy inversion is the bug to fix.** Whatever needs the user is the
   largest thing on the page. Today the painting is 400px and the three waiting
   questions are 12px.
7. **The bird appears four times only**: onboarding, completion, release, empty
   states.
8. **One floating control**, bottom-right, always the same word.
9. **No counts of open work anywhere in the chrome.**
10. **No machine confidence, ever.**

---

## 8. New components

| Component | Used by |
|---|---|
| `OutcomeHeader` | every Albatross detail |
| `StateChip` | list rows, headers, notifications |
| `NextMove` | detail, Today, mobile card |
| `PlanTimeline` | detail — steps, blockers, dependencies |
| `EvidenceCard` | detail, mail thread, completion |
| `LapsePrompt` | calendar, Today, detail |
| `ReleaseSheet` | detail, review batch |
| `ReviewBatch` | Today, notifications |
| `CapacityControl` | Today header |
| `NeedsYouList` | Today, Albatrosses, mobile |
| `AlbatrossRow` | Albatrosses list, area tab |
| `GuidedStepPane` | round 5 |

`OutcomeHeader`, `StateChip`, `NextMove` and `AlbatrossRow` unlock everything
else. Build those four first.

---

## 9. Back-end deltas that unblock the UI

All additive:

1. `released` in the work state union, with a reason, a proposer, and an optional
   review date.
2. `shape` on `albatrossIntents`: `quick` · `project` · `practice` · `decision` ·
   `monitor` · `recurring`. `albatrossRoutines` becomes the practice engine under
   it, not a peer object.
3. A `lapses` table: step, planned time, what happened, reason, reason source,
   recovery chosen, revised plan, whether the revision held.
4. One `needsYou` selector used by Today, the rail, the list, notifications and
   mobile. One definition, or the surfaces will disagree — as they already do.
5. `claim`, `confidence` and `limits` on evidence rows. Confidence stays server
   side and never reaches the screen as a number.
6. A staleness review policy per shape, and a batched review query.

---

## 10. Sequence

**Round 1 — identity and navigation.** Rename to Albatross. New sidebar. New
route enum. Delete the flag. Hide Tasks. Move Compose, mailboxes and smart
categories into Mail. Delete the unreachable surfaces. Remove the 54 upper-case
labels and every confidence score. Give Mail a real empty state. No new features.
This round alone ends the four-apps problem.

**Round 2 — the Albatross.** Promote `PlansSurface` into the shell. Merge
`WorkDetail` into it. Build `OutcomeHeader`, `StateChip`, `NextMove`,
`PlanTimeline`. Build the Albatrosses list grouped by state. Add `+ New area`.
The gold-allocation questions must become a page, not a popover.

**Round 3 — Today.** Rebuild `DailyReport` as Today: Needs you, Fixed schedule,
Flexible intentions, Important mail, Waiting, Practices, evening check-in. Cut
the weather to one line. Make Today the default view.

**Round 4 — forgiveness.** Lapse prompt, shrink, rebuild, release sheet, review
batch, re-entry. Split fixed from flexible in the calendar.

**Round 5 — proof.** Evidence cards, the outcome contract editor, mail proof
detection, the guided browser pane.

Rounds 1 to 3 change what the product looks like. Rounds 4 and 5 make it true.

---

## Appendix — how to reproduce the screenshots

```bash
PORT=18838 HOSTNAME=127.0.0.1 LAB86_ENABLE_ALBATROSS=1 \
  STAGING_BASIC_AUTH_USER=preview STAGING_BASIC_AUTH_PASSWORD=preview \
  bun --bun run next dev --turbopack
```

Then drive chromium-1228 over `--remote-debugging-pipe`, answer
`Fetch.authRequired` with `preview/preview`, sign in through `window.Clerk` with
the probe user and OTP `424242`, set
`localStorage['lab86-mail-onboarding-dismissed-v1'] = '1'` to pass the mailbox
gate, then navigate `/?view=<view>`. Driver: `/tmp/shoot.mjs`, `/tmp/shoot2.mjs`.
