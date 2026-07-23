# Native product parity: briefs, calendar, Areas, and mail

Date: 2026-07-18

Issue: [#113](https://github.com/Lab86-io/lab86-mail/issues/113)

Status: direct Codex research, implementation, and physical-device validation
complete for issue #113.

## Scope and product decision

This slice repairs four connected native loops:

1. Today renders the actual stored Daily Report instead of reducing it to a
   single string.
2. Calendar exposes real current/upcoming events and distinguishes a valid
   empty window from sync, decode, authentication, and network failures.
3. Work Areas are navigable and open a brief-first Area detail surface backed
   by the same durable Area home data as desktop.
4. Rich mail is readable immediately while scripts, forms, unsafe navigation,
   and tracking behavior remain contained.

Desktop Albatross owns the information model, content semantics, and actions.
Apple owns native navigation and control behavior. Mobbin supplies proven
mobile hierarchy and journey patterns. Albatross identity belongs in content,
typography, restrained color, art, and motion rather than custom replacements
for system navigation.

## Apple and browser research

Browserbase was used on 2026-07-18.

- [What's new in SwiftUI](https://developer.apple.com/videos/play/wwdc2026/269/)
  highlights list/grid/section reordering, toolbar visibility behavior,
  presentation APIs, observable-state initialization, and data-flow/performance
  improvements. The repair should preserve system `NavigationStack`, `List`,
  toolbar, sheet, and accessibility behavior.
- [Communicate your brand identity on iOS](https://developer.apple.com/videos/play/wwdc2026/251/)
  recommends balancing familiar system behavior with distinctive typography,
  color, content, iconography, and interaction. Custom visual material belongs
  outside system components; Albatross should not restyle navigation chrome or
  wrap every content section in decorative glass.
- Browserbase inspection of [mail.lab86.io](https://mail.lab86.io) reached the
  Clerk sign-in page rather than an authenticated product session. It confirmed
  the public positioning around unified mail and a daily brief, but it could
  not provide authenticated rendered evidence for the four target surfaces.

Repository inspection therefore supplies desktop product semantics without
claiming authenticated Browserbase visual evidence:

- `DailyReport` already owns `html`, validated `composition`, artifact status,
  sections, stats, services, and errors. The web artifact renderer lives in
  `lib/mail/report-artifact.ts`.
- Desktop Area detail reads `albatross.areaHome`, leads with the durable
  `livingBrief`, and follows it with Needs You, Projects, Work, Events, Mail,
  Tasks, Places, and Context.
- Provider calendar events are normalized by `calendar_list_events` to stable
  account/calendar/event identifiers and ISO start/end timestamps.
- The native mail renderer already strips executable/embedded content and
  restricts link schemes; its current remote-image default is what makes
  image-heavy messages appear absent.

## Mobbin searches and evidence

All searches used platform `ios`, image format `webp`, and current Mobbin MCP
results. These references are patterns to synthesize, not screens to copy.

### Today and brief hierarchy

Query: `personal productivity daily overview screen with morning brief,
upcoming calendar agenda, priority tasks, and linked action rows`

- [Asana daily overview](https://mobbin.com/screens/53b9bc89-e6fe-4844-8476-93e1ad99d0c5)
  establishes a clear greeting/date, one high-priority callout, then compact
  task and recent-work sections with explicit drill-in actions.
- [Tiimo daily plan](https://mobbin.com/screens/8ac4c7ed-88ce-4579-9eeb-ddfbee4ea458)
  uses a date rail, time-of-day groups, compact completion controls, and a
  single floating add action without obscuring the daily narrative.
- [Otter agenda](https://mobbin.com/screens/84d5c123-2972-4f2e-97c4-4f1ea7867973)
  keeps the agenda dense and scan-first: day headings, time ranges, title, and
  only the metadata/action relevant to each event.

Adopt: brief first, bounded status/progress, content-led sections, and obvious
artifact drill-ins. Reject: turning Today into a dashboard of equal-weight
cards or flattening the editorial brief into generic rows.

### Calendar agenda and detail

Query: `calendar agenda screen with date strip, grouped upcoming events, event
colors, location or attendee metadata, and empty or sync state`

- [Microsoft Outlook agenda](https://mobbin.com/screens/3a21d1a0-0bec-472b-9c07-8a33dddf45cf)
  groups events under Today/Tomorrow/date headings and preserves time, duration,
  calendar color, participant, location, and recurrence cues.
- [Amie event detail](https://mobbin.com/screens/b5537897-95ba-4e3e-b76e-36428d085b7c)
  presents date/time, guests, location, video call, description, calendar,
  repeat/all-day/destructive actions, and RSVP in one focused detail state.
- [Amie calendar with Space list](https://mobbin.com/screens/e198fa03-f4d9-4a6c-8f5c-854478fd40a2)
  demonstrates that calendar content and navigable life/work groupings can
  coexist without making the grouping rows inert.

Adopt: agenda is the robust default, rows are navigable, calendar identity is
visible, and sync/query failure is not rendered as an empty day. Reject: a
complex week grid before date mapping and real-data reliability are proven.

### Area list-to-detail journey

Screen query: `project or workspace detail screen with status summary, brief
narrative, upcoming items, linked tasks, events, messages, and obvious drill-in
rows`

Flow query: `project management flow opening a project from a list, reviewing
project overview or summary, then opening linked tasks or activity`

- [Linear Mobile project detail](https://mobbin.com/flows/0e1f8b28-bfcd-47b0-a20b-2cbe5a2f307f)
  moves directly from a sparse project list into one detail owner with Overview,
  Updates, and Issues rather than separate disconnected screens.
- [Asana project overview](https://mobbin.com/screens/4e738c2c-a7bb-447e-b5f5-3ba22cf99e62)
  leads with a project summary, then status/progress and linked properties.
- [Todoist project detail](https://mobbin.com/flows/fd394495-038d-4d75-abc9-a3295b71e5c9)
  makes every project row an obvious navigation target and keeps linked tasks
  scannable inside the selected project.

Adopt: a tappable Area row with disclosure, one brief-first Area detail owner,
then linked domain sections. Reject: duplicating desktop panes literally,
inventing local Area summaries, or presenting rows with no tap affordance.

### Mail readability and actions

Flow query: `email inbox flow opening a rich newsletter or image-heavy message,
viewing the full message, attachments, and reply actions`

- [Apple Mail email detail](https://mobbin.com/flows/62751329-3971-477e-8787-d526026f85a8)
  renders image-heavy editorial content immediately, keeps sender/thread
  context above it, and pins core mail actions to system-like chrome.
- [Microsoft Outlook email detail](https://mobbin.com/flows/7bb08323-2ede-4abe-bf61-cbd07d0fc273)
  renders plain and attachment-heavy messages inline and keeps reply/action
  controls stable at the bottom of the reading surface.
- [Gmail email detail](https://mobbin.com/flows/154cdb1c-e638-47cc-aca3-5ceea500c1fa)
  makes body text and inline images immediately readable, then offers quick
  reply/forward actions after the content.

Adopt: the message body is always the primary readable content; privacy status
is secondary and precise. Reject: a control named “Load Remote Images” that is
functionally required to reveal the message, or loading arbitrary scripts/forms
to achieve visual fidelity.

## Navigation and ownership

```text
Today
  -> Daily Report artifact
       -> typed mail/event/task/Area action route

Calendar
  -> grouped agenda row
       -> Event detail

Work
  -> Area row
       -> Area detail
            -> living brief
            -> Needs You / Projects / Work / Events / Mail / Tasks / Context

Mail
  -> Thread
       -> expanded message with immediately readable safe HTML
```

- `ProductStore` is the current incremental facade. It must retain structured
  report and Area detail data instead of deriving lossy strings in views.
- Server tools/Convex remain authoritative. Cache stores decoded snapshots for
  immediate/offline reads and never invents substitute entities.
- `NavigationModel` owns typed thread, event, and Area destinations or focused
  sheets; rows do not maintain independent route booleans.
- HTML views own only presentation and action bridging. Domain mutations still
  go through authenticated store/backend operations and approval policy.

## State matrix

| State | Daily brief | Calendar | Area detail | Mail |
|---|---|---|---|---|
| Loading | Cached artifact stays visible with bounded refresh progress. | Cached agenda stays visible; refresh is local to the surface. | Skeleton/progress names the selected Area. | Existing message metadata remains while the body loads. |
| Empty | Explain that no edition exists and offer Generate/Retry when supported. | Say no events only after a successful query for the visible window. | Explain no linked context and retain the Area identity/brief status. | Show the normalized plain-text fallback when HTML is absent. |
| Populated | Render title, status, artifact, and routed actions. | Group real events by day with time and calendar identity. | Lead with living brief, then real linked sections. | Render safe HTML and inline/remote media immediately. |
| Editing/action | Artifact actions route to existing review/mutation owners. | Detail owns edit/create entry; no optimistic provider success. | Capture/discuss/refresh uses existing server actions. | Reply/forward/attachment actions remain stable and authenticated. |
| Offline | Cached artifact is marked with last refresh; generation is unavailable. | Cached agenda remains usable with explicit freshness. | Cached detail remains readable; refresh explains offline state. | Cached body remains readable; external resources degrade without blanking text. |
| Partial failure | Artifact fallback and structured sections remain; error is local. | Healthy accounts/events remain if one provider fails. | Existing brief/links remain if one linked domain fails. | Failed images use placeholders/alt text; the message body remains. |
| Permission denied | Protected action explains required auth/approval. | Account scope problem is not “No events.” | Protected mutation waits for the same server approval. | External navigation and provider actions remain policy-gated. |
| Destructive confirmation | Dismissal/undo names the affected artifact. | Delete remains explicit and provider-confirmed. | Archive/delete is out of this repair unless already owned. | Trash remains a system confirmation/action path. |
| Large Dynamic Type | Artifact wrapper and fallback reflow/scroll without clipping. | Agenda metadata stacks; no fixed text height. | Brief properties and linked rows wrap vertically. | Sender/body/actions remain reachable; no fixed-height body truncation. |
| VoiceOver | Title, freshness/status, sections, and actions have ordered labels. | Day, time, title, calendar, and location form one useful row label. | Area identity, brief, counts, and link rows have meaningful traits. | Sender header, body, attachments, and actions have deterministic order. |

## Data and recovery rules

- Daily Report decoding distinguishes no report, partial report, rendered
  artifact, malformed artifact, and query failure.
- Calendar decoding accepts provider ISO timestamps with and without fractional
  seconds plus numeric seconds/milliseconds; an invalid required date rejects
  the event instead of creating a 1970 event.
- A successful zero-event result is distinct from calendar scope/sync/query
  failure. Retry and sync recovery stay visible near the Calendar surface.
- Area detail is loaded by stable Area id. Missing/archived Area returns an
  unavailable state and a route back to all Areas.
- Mail HTML keeps script, iframe, object, embed, form, input, event-handler,
  refresh, and unsafe-link protection. Remote media failure must preserve text,
  alt text, layout, and plain-text recovery.

## Acceptance evidence

- Focused Swift tests for report, calendar, Area, routing, cache, and HTML
  security/readability contracts.
- Focused TypeScript tests for any new server tool/query contract.
- `bun run lint`, `bun run typecheck`, affected test suites, Xcode build/tests.
- Rendered screenshots for the same populated/empty/error states compared with
  the references above.
- Signed install and manual verification on the connected physical iPhone.

## First-party research round (direct Codex implementation pass, 2026-07-18)

This section records the implementation research used directly by Codex in
addition to the earlier gate. Patterns below are grounding to synthesize, never
screens to copy. Apple guidance takes precedence over any app pattern.

### Mobbin (platform ios, webp, MCP `deep` mode)

Today / daily brief — query: `daily agenda home screen with editorial morning
brief headline, status, and progress, then a compact schedule and priority list`

- [Asana Home](https://mobbin.com/screens/53b9bc89-e6fe-4844-8476-93e1ad99d0c5):
  dateline + greeting, then ONE dismissible high-priority callout ("A task is due
  in 3 days" → View task), then a compact "My tasks" list with due chips and a
  single "Go to My Tasks" drill-in, then "Recents". Strongest hierarchy match for
  the native fallback: brief → bounded callout → compact list → obvious drill-in.
- [Tiimo Plan](https://mobbin.com/screens/1d1a66c2-4c45-4f3c-9caa-2979e8e340b8):
  editorial serif date headline, time-of-day groups ("To do anytime"/"Planned"),
  compact completion controls, one FAB — editorial density without card noise.
- [ClickUp My Work](https://mobbin.com/screens/99d9d5ab-d435-4fa1-aad0-1588f34fb2b8):
  day-grouped agenda where empty days say "No tasks · create one" — an explicit
  empty affordance per day, never a blank.
- [monday.com My Work](https://mobbin.com/screens/669c934e-c45f-4d9f-a558-b4a72f04c6ea):
  bounded status-count chips (This Week / Next Week / Later) above grouped lists.

Adopt: dateline headline, bounded status/progress, one callout, day-scoped
schedule, drill-ins. Reject: equal-weight card dashboards; per-day blanks.

Event detail — query: `calendar event detail screen showing date and time,
location, video call link, attendees list, notes, and calendar source`

- [Amie event detail](https://mobbin.com/screens/c62cb2e7-3743-4105-a1ef-68f9c9ef5749):
  labeled property grid — Date/From, Date/To, Guests (avatars), Location, Video
  call (Meet link), Description, Calendar (account email + icon), then
  Repeat/All-day and an RSVP pill. Canonical rich read layout.
- [Microsoft Outlook event](https://mobbin.com/screens/16e92069-8194-4b42-90e0-69463aa8d34a):
  colour dot + title, All-day/date, description, map snapshot + address,
  "Teams Meeting · Join", attendee row (avatar + email, chevron), Show More
  (reminder / free-busy), Email/Forward.
- [Cron event](https://mobbin.com/screens/90c8e044-964d-4409-b158-66d61ee71dc9):
  primary "Join Google Meet" button, Meet code, location, description, organizer,
  Free/Private, reminders.

Adopt: title + calendar identity, date/time or All-day, account/calendar source,
location, conference/join, attendees (name/email), description, organizer — all
from real fields only, in native `List` sections. Reject: RSVP/edit affordances
the native client cannot actually perform; render read-only detail.

Area (project) list-to-detail — query: `project workspace detail screen leading
with a summary brief, status counts, then linked tasks events and messages
sections`

- [Asana project Overview](https://mobbin.com/screens/4e738c2c-a7bb-447e-b5f5-3ba22cf99e62)
  and [on-track variant](https://mobbin.com/screens/905d6029-4f4a-4d8b-9d47-b4b300a364a8):
  back → big project title → summary card → status row → Overdue/Due tiles →
  progress bar "83% complete · 6 total tasks" → owner/due → connected goals.
- [Linear Mobile project](https://mobbin.com/screens/2d1fdc3c-3758-46bb-88e1-5cfd39ce4148):
  title + Overview/Updates/Issues, a summary paragraph, then quiet property
  badges (In Progress, High, assignees, linked PR). Plan-as-document density.
- [Notion project](https://mobbin.com/screens/5b6d8751-ebcd-48c7-94b8-554df8d17e65):
  title, property rows, Overview body, comment composer.

Adopt: header (area mark + name + kind + verified/suggested counts) → living
brief lede+summary → bounded property chips → linked sections (Needs You,
Projects with progress, Work/plans, Events, Mail, Tasks, Context, Places), every
row an obvious navigation target where a real destination exists. Reject:
duplicating desktop panes literally; inventing local summaries.

Rich email — query: `opened email message with image-heavy newsletter content
rendered inline, sender header, and reply forward actions`

- [Apple Mail — Artsy newsletter](https://mobbin.com/screens/96205938-97cb-4526-a2a3-cafe6843f33a),
  [with mailing-list banner](https://mobbin.com/screens/173573f7-9203-4ded-bf93-a716b9ee8b94),
  [Tock guide](https://mobbin.com/screens/8e76c9bd-1402-43b3-97ac-fc4f19de9564):
  image-heavy editorial renders inline immediately; sender/To/Reply-To pinned
  above; a quiet "This message is from a mailing list · Unsubscribe" banner; core
  actions (archive/folder/reply/compose) pinned as bottom chrome. No image gate.
- [Gmail — photo email](https://mobbin.com/screens/e6e6f097-3f0a-4114-8c5c-ea852d8701f1):
  body text + inline photos immediately readable, then a one-tap reply chip.

Adopt: message body + normal remote/editorial images are the primary content and
render immediately; privacy handling is silent and precise (strip beacons, keep
editorial images). Reject: any control that is effectively required to reveal the
message ("Load Remote Images").

### Apple / Browserbase guidance and tool limitations (honest record)

- `WebFetch` of the HIG Typography page returned only the page title; that page is
  client-rendered and its body did not resolve to markdown, so no verbatim Apple
  text was captured this round. The prior gate already cited the WWDC 2026
  "What's new in SwiftUI" (system `NavigationStack`/`List`/toolbar/sheet) and
  "Communicate your brand identity on iOS" (distinctive typography/colour/content,
  not restyled system chrome) sessions; those remain the governing Apple sources.
  Implementation therefore relies on well-established, non-invented Dynamic Type
  rules (semantic `Font.TextStyle`, no fixed text heights, reflow/scroll at large
  sizes) rather than freshly quoted text.
- Browserbase again reaches only the signed-out Clerk state of mail.lab86.io, so
  authenticated desktop rendering is grounded from repository source
  (`components/albatross/AreaHome.tsx`, `lib/mail/report-artifact.ts`,
  `lib/mail/report-area-brief.ts`, `lib/tools/calendar.ts`), not screenshots.

### State matrix — confirmed

The state matrix above is confirmed for implementation. One clarification carried
into code: the Daily Report artifact is rendered in a dedicated sandboxed
`WKWebView` whose ONLY script is a nonce-scoped native click bridge; every
model-authored script is stripped, and artifact actions are read-only navigation
(`open_thread`/`open_event`/`open_area`/`open_view`) or route to the existing
review surface — never a silent provider mutation.

### Physical-device finding — wide mail tables (iPhone 17 Pro, iOS 27, 2026-07-18)

Rendered-screenshot review of a real GitHub Actions notification confirmed the
rich-HTML/remote-image repair (logo, workflow graphic, button, and status table
all rendered immediately, no image gate). One readability defect surfaced: the
narrow "Status" column of the desktop status table was crushed to one letter per
line ("S t a t u s"). Root cause was the injected `EmailHTMLDocument` CSS
combining `table { max-width: 100% !important }` (forcing wide desktop tables to
viewport width) with a body-inherited `overflow-wrap: anywhere` (letting cell
text break at any character), so a too-wide table honored `max-width` by stacking
each glyph vertically.

Decision (native-feeling, CSS-only, no JS): keep the `max-width: 100%` bound so
ordinary responsive/marketing tables still fit the viewport unchanged, but let an
inherently wide table scroll horizontally within that bounded box
(`display: block; overflow-x: auto`) and stop per-character breaking inside cells
(`th, td { overflow-wrap: normal }`) so whole words like "Status" stay on one
line. Long-word recovery for ordinary prose remains at the body level. This is
grounded in the Apple/Gmail/Outlook mail patterns above (body is primary readable
content; wide content pans rather than distorting) and standard mobile
responsive-email table handling — not a second mail architecture.

### Direct Mobbin follow-up after physical review (2026-07-18)

Screen query, platform `ios`, mode `deep`, format `webp`: `opened rich email
message with inline images and a wide structured status or receipt table, sender
header, full readable body, and reply actions`.

- [Apple Mail — Artsy rich message](https://mobbin.com/screens/96205938-97cb-4526-a2a3-cafe6843f33a)
  preserves the publisher's editorial composition inside native sender and action
  chrome; content may extend naturally rather than being compressed into a new
  card layout.
- [Gmail — photo message](https://mobbin.com/screens/e6e6f097-3f0a-4114-8c5c-ea852d8701f1)
  keeps prose legible at the viewport width and renders inline media without a
  disclosure gate.
- [Microsoft Outlook — structured report](https://mobbin.com/screens/ce924373-b1de-4179-a0d2-8a4c88183e4c)
  keeps the structured message body primary while native quick replies and mail
  actions remain outside the content.

Flow query, platform `ios`, format `webp`: `email inbox journey opening an
image-heavy or structured rich HTML message, reading the full body, then using
reply or forward actions`.

- [Apple Mail — browsing rich messages](https://mobbin.com/flows/b8f76723-5c51-4f2c-9219-c84ddc07c633)
  moves directly into full editorial bodies and keeps mailing-list/reply controls
  secondary.
- [Gmail — email detail](https://mobbin.com/flows/154cdb1c-e638-47cc-aca3-5ceea500c1fa)
  preserves body flow first, inline media second, and reply/forward after reading.
- [Microsoft Outlook — email detail](https://mobbin.com/flows/7bb08323-2ede-4abe-bf61-cbd07d0fc273)
  keeps attachments, message structure, quick replies, and native actions distinct.

Adopted: faithful body rendering, immediate editorial media, whole-word table
cells, contained horizontal pan only for inherently wide structures, and native
actions outside provider HTML. Rejected: squeezing provider tables until labels
stack character-by-character, rewriting message content into Albatross cards, or
making remote-image permission the path to basic readability.
