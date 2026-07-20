# Mobbin research — iOS surfaces round (2026-07-20)

Six surfaces researched on Mobbin (`platform: ios`, deep mode) for the Albatross native app. Every reference below was visually inspected; observations describe what is actually on the screen, not metadata. Where a reference conflicts with Albatross taste rules (no sparkle icons, no icons-before-text, no ALL-CAPS micro-labels), the conflict is called out so we steal the structure, not the styling.

---

## 1. AI assistant chat (in a productivity/mail app)

### Notion — AI assistant sheet
- Mobbin: [Notion AI chat sheet](https://mobbin.com/screens/722b5a96-45b4-4fe8-bccb-23dd19250e48)
- Image: https://mobbin.com/api/mcp/short/k9jyZPN6
- Presented as a card sheet stacked over the workspace (you can see the parent page's rounded corner peeking at the very top) — chat is a layer, not a destination.
- Zero-state is calm: small logo mark, one-line greeting, then a "Suggested" label with four plain-text action rows. The suggestions are a vertical list, not bubbles or pills — scannable and quiet.
- Composer is a single hairline-bordered field with placeholder "Ask anything or select…", scope dropdown ("All"), attach and mention affordances tucked inside the field, and a small circular send button. Everything lives in one row.
- AI responses render as plain full-width text on the page background, not in bubbles — only the user gets a bubble. Good match for Albatross's editorial voice.
- Note: Notion puts small icons before each suggestion label; Albatross should render the same rows text-only.

### Navigator — chat with inline rich cards
- Mobbin: [meeting search card in chat](https://mobbin.com/screens/5d065331-8c30-403d-9f43-720265fa6029), [meeting plan card + quick replies](https://mobbin.com/screens/a1ae4103-d1f9-4595-bc87-28c298231c1f)
- Images: https://mobbin.com/api/mcp/short/cSk7fl0N , https://mobbin.com/api/mcp/short/TGn6FUwE
- Tool results are true widgets inside the thread: a white elevated card with its own search field and a result row (meeting title, cadence, attendee avatars) sits full-width between bubbles. The card is functional, not a screenshot of data.
- The meeting-plan card uses internal hairline dividers to build a mini key-value table (Prepare for meeting / Thursday, Preview agenda / Thursday evening…), then a tappable drill-in row ("Dashboard, 6 outreach events" with chevron). One card = one entity with its facts and one action.
- Assistant messages are short, one sentence per bubble, sequenced — reads like a colleague, not a wall of text.
- User quick-replies are offered as suggested reply bubbles anchored bottom-right in the user's color ("Let's do it", "What will ethan see?") — HITL confirmation without a form.
- Soft blue-gray gradient background pushes white cards forward with almost no shadow; contrast does the elevation work.

### Manus — agent progress + result cards
- Mobbin: [parallel task progress](https://mobbin.com/screens/8a153d98-64f5-4d63-a0c4-e079dd7511d5), [deliverable card](https://mobbin.com/screens/c64c719b-b356-44c9-827b-d7f826cb0201)
- Images: https://mobbin.com/api/mcp/short/Zqp31t31 , https://mobbin.com/api/mcp/short/nGUIuU3J
- Long-running work is a collapsible checklist in the transcript: section headers with completion checkmarks and chevrons, sub-steps as rows with individual spinners and a "0/50" counter chip. Progress is legible at a glance mid-stream.
- Finished work lands as a compact artifact card: favicon + title + age, an embedded live preview thumbnail, and a two-button footer ("Dashboard" ghost, "Visit" solid black). The deliverable is a first-class object you can act on, not a link in prose.
- Status line "Task completed" in green with a check sits between transcript and composer — a one-line state signal, no banner.
- Composer stays minimal while an agent runs: plus button, context chip (connected accounts "+2"), mic, and the send button swaps to a stop square.

### Beside — actions above the composer
- Mobbin: [group chat with private AI answer](https://mobbin.com/screens/71796e40-c453-4f8d-958c-c4c4109ecd3b)
- Image: https://mobbin.com/api/mcp/short/tbDeWztV
- The user's AI query renders as a dashed-outline bubble labeled "Only visible to you" — a distinct visual grammar for talking to the machine vs. talking to people. Useful if Albatross chat ever coexists with human-facing mail content.
- AI answer is full-width structured text (paragraphs + a real bulleted list), with a small feedback row (copy, thumbs, source count) under it — utilities are tiny and gray, never competing with content.
- A horizontally scrolling row of pill buttons ("Ask Beside AI", "Saved Replies") sits between the transcript and the input field — persistent entry points that don't crowd the composer.

**Surface verdict:** Notion's layering + bubble-less AI text, Navigator's entity cards with hairline key-value tables and suggested-reply confirmation, Manus's progress checklist and artifact card. That trio maps directly onto Albatross's tool-UI grammar (show_* tools, HITL suite) on iOS.

---

## 2. Quick capture (task/intent)

### Tiimo — "What's next?" capture bar
- Mobbin: [day view capture](https://mobbin.com/screens/23ff4bff-949b-4b4f-86f8-60f7c2085f0d), [tag suggestion sheet](https://mobbin.com/screens/defe1eb0-8426-4110-a9f1-478790cecdf5)
- Images: https://mobbin.com/api/mcp/short/FotvrLgB , https://mobbin.com/api/mcp/short/2Sk4GJNP
- The capture field rises straight from the day view as a rounded sheet with a serif italic placeholder ("What's next?") — the single most on-brand reference in this round for Albatross's Fraunces voice.
- Metadata is a row of small outlined chips directly under the field ("Anytime", repeat, overflow "…") plus a solid-black "Speak" pill — defaults visible, everything editable in one tap, keyboard never dismissed.
- The day context (serif "Friday", date, upcoming blocks) stays visible above the sheet; capture never takes you out of the day.
- The tag sheet is a second stacked layer: wrap-layout outlined chips, "Suggest a tag" utility top-left, "Done" top-right — picking metadata is browsing chips, not a form. (Tiimo's emoji-in-chip styling would be dropped.)
- Confirm is the keyboard return key tinted as a checkmark — no separate save button anywhere.

### Todoist — the canonical quick add
- Mobbin: [quick add with chips](https://mobbin.com/screens/c0cf3743-238a-46c0-967c-ad91f7df8513), [NL priority parsing](https://mobbin.com/screens/b86af472-cb4e-4617-84a7-7bd6d349e8ce)
- Images: https://mobbin.com/api/mcp/short/8qae8yAA , https://mobbin.com/api/mcp/short/kkEwmwMT
- Structure: title line, gray description line, one horizontally scrolling chip row (Date, Deadline, Priority, Reminders), then a destination row ("Inbox ▾") with the circular submit button at the right — four stacked zones, nothing else.
- Natural-language tokens highlight live inside the text as you type ("!!1" renders as a red P1 chip in-line) — parsing is visible and reversible before commit.
- Chips are stateful: once set, the chip fills with its value/color (red "P1" flag) so the row doubles as a summary of what will be created.
- The sheet has a large top radius and floats over the dimmed previous screen — context retained, ~40% of the parent still visible.

### Attio — capture with pre-resolved context rows
- Mobbin: [create task sheet](https://mobbin.com/screens/dc9d6419-9111-428c-9c98-a1d2b382f344)
- Image: https://mobbin.com/api/mcp/short/kkEwmwMT (list context) / https://mobbin.com/api/mcp/short/396qPsor — canonical: https://mobbin.com/api/mcp/short/kkEwmwMT
- Header row is plain text: "Create Task" centered, blue "Create" text button right — no icon buttons at all.
- Below the title input, three left-icon rows show already-resolved metadata (date chip "Aug 28, 2024", linked company "SLMobbin", assignee with avatar "Alex Smith") — the system's guesses are displayed as filled values, not empty fields to fill.
- The parent task list stays visible above the sheet, so the row you're adding next to is still in view.

### Asana — minimal two-fact capture
- Mobbin: [task name sheet](https://mobbin.com/screens/393b3e59-224d-4667-9d67-1e8f26cb83fb)
- Image: https://mobbin.com/api/mcp/short/zkLJR83x
- Only three things above the keyboard: title field, "Assigned to" with avatar, "Due Date" with a dashed placeholder circle — dashed outline as the "not yet set" affordance is a nice, quiet empty-state for chips.
- "Create" is a plain text button aligned right of the utility icons; an expand arrow (top-right of sheet) promotes the quick capture to the full editor without losing typed text — the escape hatch Albatross's intent capture should have.

**Surface verdict:** Tiimo's serif prompt + chip row + visible day context is the personality target; Todoist supplies the mechanics (live NL token highlighting, stateful chips, destination row); Asana supplies the promote-to-full-editor escape hatch.

---

## 3. Full-screen daily briefing / immersive reading

### Timepage (Moleskine) — Today brief with zero chrome
- Mobbin: [Today with schedule + weather](https://mobbin.com/screens/01287266-ba8d-4a3c-af59-02600ee64df3), [variant](https://mobbin.com/screens/4cf462c1-4da7-4a6c-9aa0-44230eef2c01), [dark variant w/ actions](https://mobbin.com/screens/5fd62b9b-167c-48aa-8e40-33b1d13dfe12)
- Images: https://mobbin.com/api/mcp/short/fIl0Lwqi , https://mobbin.com/api/mcp/short/nbf8mJTq , https://mobbin.com/api/mcp/short/TSJ9Axil
- The entire screen is one tinted monochrome field (warm taupe; dark variant near-black) — no nav bar, no tab bar, no status chrome beyond two ghost arrows and a "+". The date masthead ("TODAY / August 8") is centered type on the field itself.
- Content blocks (each meeting, weather) are cards made of the same hue a few percent lighter — tone-on-tone elevation with no borders and no shadows. This is the cheapest, most elegant depth recipe in the whole round.
- Every schedule card is center-aligned: title, "9:30 AM → 10:30 AM", a short colored underline accent, then a one-line annotation ("Bring a brolly"). The underline is the only saturated element per card.
- Left/right ghost chevrons page between days — the brief is a horizontally paged document, not a scrolling feed.
- The dark variant shows an "Actions" section where completed items render struck-through on a red card and pending ones on amber — state as card color, still no icons.
- Adaptation: swap Timepage's ALL-CAPS "TODAY"/"SCHEDULE" labels for Fraunces sentence-case; keep the tone-on-tone card system wholesale.

### Finimize — "Your Daily Brief" editorial page
- Mobbin: [Daily Brief May 14th](https://mobbin.com/screens/5d326d90-9cdc-44c6-9572-1a45f22cfb64), [Daily Brief Dec 5th w/ audio](https://mobbin.com/screens/fa6bd7d5-fe63-478c-be77-566b08b57a61)
- Images: https://mobbin.com/api/mcp/short/4y418KFN , https://mobbin.com/api/mcp/short/YDnlUFef
- Title is literally "Your Daily Brief For May 14th" — dated, personal, followed by a two-sentence dek in gray that summarizes the whole brief before any body content. Headline + dek + "3 min read" metadata is the exact editorial header pattern the Albatross brief should use.
- Chrome is four small utility glyphs in a single top row (back, play/listen, download, bookmark) over plain white — the header disappears into the page; no bar, no background.
- A full-bleed branded hero image separates the dek from the first story; section headlines below are large bold sentence-case.
- The Dec 5 variant adds a persistent audio player bar docked at the bottom (thumbnail, title, skip-15, play) — listen-to-your-brief as ambient chrome rather than a separate screen.
- "Mentioned in story" entity chips (ticker avatar + name in white cards) at the bottom link the narrative to objects — the same move as linking brief sentences to threads/events/tasks.

### Play — hero-first article template
- Mobbin: [reading view](https://mobbin.com/screens/3504001d-1af0-475c-9b7a-19635c4bd620)
- Image: https://mobbin.com/api/mcp/short/0ts5cpFm
- Full-bleed photo up top with the date as a small overlay caption, then an oversized bold title, a bold one-line standfirst, and body in gray — a strict four-level type hierarchy doing all the structure, zero rules or boxes.
- Nav is a thin translucent bar with only back and share; it reads as part of the page, not a bar.

**Surface verdict:** Timepage is the strongest reference in the entire round — tone-on-tone cards on a tinted full-screen field, paged days, centered time typography. Finimize contributes the dated title + dek + read-time header, entity chips, and the docked listen bar.

---

## 4. Email compose

### Apple Mail — subject-as-headline compose
- Mobbin: [compose with format sheet](https://mobbin.com/screens/1f7a67d8-6974-4225-bc3c-0ae05599dfe8), [variant](https://mobbin.com/screens/69f28242-e946-4453-9ef8-7e40b6e75b63)
- Images: https://mobbin.com/api/mcp/short/bPolhoRQ , https://mobbin.com/api/mcp/short/KMYLRKiP
- The subject is rendered as a huge bold page headline ("Hello, how are you?") at the top of the sheet — compose looks like authoring a document, not filling a form. This is the single best compose move for an editorial app (set it in Fraunces).
- Chrome is just two floating circles: gray X top-left, filled accent up-arrow (send) top-right. No nav bar, no toolbar visible until needed.
- Recipient rows are hairline-separated plain text; "Cc/Bcc, From:" collapses to one gray line until tapped. To: names are accent-tinted text, not boxed chips.
- Formatting lives in a stacked bottom card sheet ("Format" with a grid of segmented controls: B/I/U/S, font stepper, color, lists, alignment, indent) that slides over the compose sheet — full power, zero persistent toolbar chrome.
- Text selection shows round accent grab handles; selected range tinted in the same accent — one hue does all interactive states.

### Microsoft Outlook — the working-toolbar baseline
- Mobbin: [compose with toolbar](https://mobbin.com/screens/90730fe9-832c-48a5-ba6b-41040322bdac), [toolbar above keyboard](https://mobbin.com/screens/70613aa2-2956-4388-a64f-5b3b089ff66d), [attachment rows](https://mobbin.com/screens/3ab6287c-5a71-4d28-a92a-c76fd25e8ab6)
- Images: https://mobbin.com/api/mcp/short/PWtEsw0o , https://mobbin.com/api/mcp/short/z0wI5Xpx , https://mobbin.com/api/mcp/short/euxfL7zD
- Header pairs sender identity (avatar + "New Message" + from-address) with a single send icon — worth stealing: show which account is sending, always, since Albatross is multi-account.
- The utility strip (attach, camera, draw, format, tables, schedule-send, overflow) floats as a rounded capsule above the keyboard, detached from the keyboard edge — it reads as a tool palette, not a system bar.
- Formatting toolbar shows B/I/U as plain letterform glyphs plus a "Body" style dropdown — style-name dropdown scales to a real type system better than a row of 12 icons.
- Attachments appear as full-width hairline rows under the subject (file icon, truncated name, size, remove X) — list rows, not thumbnails, consistent with the mail metaphor.
- Cc field validates inline: an unresolved recipient ("john") renders as a red-tinted token in place.

### Gmail — the minimum viable compose
- Mobbin: [compose](https://mobbin.com/screens/f2f7c87e-1dc9-4bf3-bb28-785b728d5974)
- Image: https://mobbin.com/api/mcp/short/2uWxjNyd
- Recipient is a single avatar-chip token (avatar + full address in a pill); From collapses to one gray line with a disclosure chevron.
- Four total header glyphs (close, attach, send, overflow); subject and body are undecorated hairline-divided lines. Proof of how little chrome compose actually needs — the ceiling for Albatross's "quick reply" compose mode.

**Surface verdict:** Apple Mail's subject-as-headline + two floating circles + formatting-as-sheet is the model; add Outlook's from-account identity in the header and its floating capsule utility strip.

---

## 5. Email thread / conversation view

### Microsoft Outlook — collapsed history + suggested replies
- Mobbin: [thread with quick replies](https://mobbin.com/screens/3502aa8b-f0ab-4d42-806a-b4aa94adfee7), [dark w/ mention + attachment](https://mobbin.com/screens/ce924373-b1de-4179-a0d2-8a4c88183e4c), [expanded header + draft row](https://mobbin.com/screens/0a6b0394-6009-4473-b072-e04a65f16e3b)
- Images: https://mobbin.com/api/mcp/short/OwTXinme , https://mobbin.com/api/mcp/short/h31foK6s , https://mobbin.com/api/mcp/short/xMQ7IGVp
- Subject renders once as a slim sticky title bar with the attachment count pinned right; individual messages don't repeat it.
- Message header is avatar + name + "To You" in two compact lines; tapping expands to full addresses and timestamp in place. The latest message is fully expanded, body set in comfortable reading measure.
- Suggested replies are white pill bubbles ("Not at this time. Thank you.", "Thank you, I will let you…") floating in a horizontal row above the reply bar — generated text presented as tappable speech, cut off at screen edge to signal scrollability. Albatross version: same pills, voice-matched copy.
- The reply bar is one rounded capsule: reply-arrow + "Reply" text on the left, then message-level verbs (mark, delete, archive, overflow) in the same capsule — compose entry and triage actions share one dock.
- In-thread drafts appear as a red-labeled "Draft" row inline in the conversation with a trash affordance — unfinished replies live in the thread, not a separate folder.
- Dark variant: @mention rendered as an accent-highlighted token inside body text; attachment as a compact gray chip row (PDF icon, name, size) directly under the sender header.

### Spark Mail — AI summary as a distinct layer
- Mobbin: [summary card in team thread](https://mobbin.com/screens/a3a32838-87bc-408f-86a7-e5d6651d665c), [dark full-screen summary](https://mobbin.com/screens/b8686e69-f1cc-4989-8687-06bf53ca3004), [summary type picker](https://mobbin.com/screens/3435e962-36b5-4320-8c76-3786af34289f)
- Images: https://mobbin.com/api/mcp/short/L8PBA646 , https://mobbin.com/api/mcp/short/32AOAKH5 , https://mobbin.com/api/mcp/short/ANS8NdtA
- The generated summary is a full-width card visually quarantined from real messages: purple-tinted background with a left accent rail, its own header row ("+ai Summary", timestamp, overflow) — you can never mistake machine text for a human message. Albatross should keep the quarantine but do it with a Fraunces label and accent-tinted card, no gradient.
- Summary card sits inline in chronological position in the thread, between messages — it's part of the record, not a popover.
- Summary length is user-controlled via a bottom sheet with three visual density thumbnails (Short / Detailed / Action Points) plus a per-sender "Always summarize emails from Apple" toggle — summary-as-preference, not one-shot.
- System events ("Assigned this email to you and set deadline for…") render as plain gray text rows with accent-tinted data — a third text register besides human and AI.
- Thread-level actions (done, reply, overflow) live in a fixed bottom bar of plain glyphs; the header carries participant avatars overlapped in the top-right as a compact "who's here" signal.

### Goodreads — latest-first with thread ledger
- Mobbin: [message + other messages in thread](https://mobbin.com/screens/2c9e5860-4345-405a-ad55-d8c5455cf1a7)
- Image: https://mobbin.com/api/mcp/short/1x0z1q3F
- Latest message shown as a full reading surface (large sender name, To-line, relative time), while history collapses under an "Other Messages in Thread" section header as one-line rows (avatar, subject, age, one-line snippet, chevron) — the two-tier "read the new thing, scan the ledger" structure in its simplest possible form.
- "Reply" is a plain-text pill top-right in the header — reply as the page's single named action.

**Surface verdict:** Outlook contributes the collapsed-header mechanics, suggested-reply pills, and the unified reply/triage capsule; Spark contributes the quarantined inline summary card with density control. Combine both under Albatross typography.

---

## 6. Email inbox list

### Apple Mail (iOS 26) — the modern system inbox
- Mobbin: [categories row + list](https://mobbin.com/screens/29577d38-adb0-43cd-8d37-c6792146fc2f), [filtered + floating dock](https://mobbin.com/screens/447acbfc-a1e6-4d2e-a32a-2c1be0a2174c), [transactions category](https://mobbin.com/screens/4a7b840c-5b83-4080-a5dd-829bbcfd05aa), [all mail](https://mobbin.com/screens/c7954d28-d0a2-44f2-8d6d-b8e304b729d6)
- Images: https://mobbin.com/api/mcp/short/5bNch9TP , https://mobbin.com/api/mcp/short/paOxzvWn , https://mobbin.com/api/mcp/short/396qPsor , https://mobbin.com/api/mcp/short/Se4bgsVg
- Header: huge left-aligned "Inbox" with a gray one-line status beneath ("Gmail · Updated Just Now"); nav actions are floating frosted circles (back, Select, overflow), not a bar. Title-as-masthead fits Albatross exactly (set it in Fraunces).
- Categories are a horizontal row of pills where only the selected one is expanded with label + tint (blue "Primary", green "Transactions", black "All Mail") and unselected ones collapse to glyph-only pills — selected-state-carries-the-label keeps the row compact. (Albatross variant: text-only pills, since glyph-only fails the no-icon-only rule.)
- Rows: rounded-square sender avatar, bold sender, regular subject, 2-line gray preview, right-aligned time + chevron; the unread dot is a small blue dot in the left gutter outside the content column — scanning for unread is a single vertical eye-track.
- Bottom chrome is a floating capsule dock: filter circle + search field + compose circle, hovering over the scrolling list with heavy blur; list content is visible sliding underneath. The filter chip expands in place to show active state ("Filtered by Unread ▾").
- Category explainer cards (tinted blue/green with "Try Categories / Turn Off" text links) appear inline at the top of the list and are dismissible — feature education as a list citizen, not a modal.
- In the Transactions category, rows group by sender with per-message sub-bullets ("Your order has been received…", "Your order from Veg Out…") — bundling as indented lines within one row.

### Spark Mail — Smart 2.0 grouped inbox
- Mobbin: [smart inbox with bundles](https://mobbin.com/screens/e9e26a8d-f758-401c-9687-11f4ea4530a4), [grouping explainer](https://mobbin.com/screens/ae65657f-25e7-467d-81e4-767f594f310f), [priority senders](https://mobbin.com/screens/aa953e07-52f4-446b-bfa8-2c69e5188654), [expanded groups](https://mobbin.com/screens/90db9130-c42d-42ed-89d6-a8ed9f75ffe1)
- Images: https://mobbin.com/api/mcp/short/jWovCWLZ , https://mobbin.com/api/mcp/short/GIewxWfT , https://mobbin.com/api/mcp/short/J5ZiOkRo , https://mobbin.com/api/mcp/short/bOXBQKIn
- Notifications and Newsletters collapse into single bundle rows: outline glyph avatar, bold label + "99+" count, then a mini-row of sender favicons with names ("Apple, Spark, Google") as the preview line — the bundle previews *who*, not *what*. Directly applicable to Albatross area/category rows.
- Priority senders stick above bundles regardless of recency — importance beats chronology at the top of the list.
- Section headers are bare lowercase-gray date labels ("Today", "September", "August") with generous top spacing — time grouping with zero ornament.
- Inside an expanded bundle, "View All (65)" appears as a centered blue text link after ~3 rows — progressive disclosure without leaving the list.
- The whole list is flat white with no cards, no dividers — hierarchy comes entirely from type weight, avatar shape, and spacing.

### Microsoft Outlook — segmented focus + flagged filter
- Mobbin: [Focused/Other inbox](https://mobbin.com/screens/c1ac5112-2afc-4f7f-bda6-47bc0f4794a7), [flagged filter](https://mobbin.com/screens/d16f67f7-3dbf-437a-a625-5a76f8d97285)
- Images: https://mobbin.com/api/mcp/short/WZpWP9tq , https://mobbin.com/api/mcp/short/2upnUfVT
- Focused/Other is a two-segment pill embedded in the colored header next to the title — the split-inbox toggle costs one control, no tab bar.
- Category tags render inline in the preview area as small tinted chips ("Orange category") on the row itself — per-row taxonomy without a dedicated column.
- With the flagged filter active, matching rows get a soft cream row-tint and a red flag on the right — filter state is visible on every row, not just in the control.
- Two stacked floating action circles (new mail, edit drafts) bottom-right in a shared frosted lozenge.

**Surface verdict:** Apple Mail's masthead + gutter unread dots + floating search/compose dock is the structural base; Spark's bundle rows with sender-favicon previews are the model for Albatross area/category bundling; Outlook's two-segment split control handles Focused-style splits.

---

## Depth playbook — recurring elevation techniques across all references

1. **Tone-on-tone cards, not shadows.** Timepage builds its entire brief from cards that are the background hue lightened a step — no borders, no drop shadows. Navigator does the inverse (white cards on a tinted gradient field). Rule: pick a field tint, elevate by lightness delta; reserve true shadows for the topmost floating layer only.
2. **Floating capsules instead of bars.** Apple Mail's search/compose dock, Outlook's compose utility strip and reply capsule, Beside's action pills — bottom chrome is consistently a detached, heavily-blurred rounded capsule hovering over scrolling content, with content visibly sliding beneath. Nothing spans edge-to-edge anymore.
3. **Sheet stacking with visible parent.** Notion AI, Todoist quick add, Tiimo tags, Apple Mail's Format panel: every transient surface is a large-radius (~20-24pt) sheet that leaves the parent context visibly peeking and dimmed above it, and sheets stack two deep (capture sheet → chip picker). Depth = how many layers of context you can still see.
4. **Quarantine tint for machine text.** Spark's summary card (tinted background + accent rail + labeled header) and Beside's dashed "only visible to you" bubble both give AI content a dedicated visual register distinct from human messages. One tint + one label, applied consistently, is enough.
5. **Cards-in-transcript get exactly one elevation step.** Navigator's meeting cards, Manus's artifact cards, Brex's stacked activity cards: inline tool results are white/elevated one step above the chat field, use internal hairline dividers for structure, and carry their own action row. Never nest a second elevated card inside.
6. **Frosted circles for nav.** Apple Mail and Tiimo replace nav bars with individual frosted-glass circular buttons floating over content (back, select, overflow). The page owns the top edge; controls are guests on it.
7. **Selected state carries the label.** Apple Mail's category pills (selected pill expands to show text + tint, unselected collapse) and Outlook's segment pill: compact control rows spend horizontal space only on the active choice.
8. **Accent does all interactive states.** Apple Mail compose (send button, recipient names, selection handles, selected text all one blue) and Timepage (one saturated underline per card): a single accent hue per context marks everything touchable, which is exactly how Albatross's dual-accent palettes should behave per surface.

## Taste-rule adaptation notes

- Timepage's ALL-CAPS section labels ("TODAY", "SCHEDULE", "WEATHER") violate the no-ALL-CAPS rule — keep its layout, set labels in Fraunces sentence case.
- Notion/Evernote/Todoist put glyphs before suggestion/chip labels — Albatross renders the same rows and chips text-only.
- Spark's "+ai" gradient badge and Apple Mail's category star glyph are exactly the sparkle-adjacent marks the style guide bans; the quarantine-tint pattern works without them.
