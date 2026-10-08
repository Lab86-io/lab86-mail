# Albatross thread, web design note (2026-10-07)

> **Lead decisions override this note.** `docs/albatross-thread.md`, section "Cross-platform
> decisions (lead review, 2026-10-07)", settles the open questions. Where this note differs, the
> decisions win: no "sent your note to the run" row (decision 8), "Dismiss" for a run handoff and
> "Skip" for a chat form (decisions 3 and 4), and no "Check the page" in the thread (decision 5).
> The sections below are updated to match.

Status: design only. No production code changed. The brief is `docs/albatross-thread.md`. The
contract is `lib/albatross/thread-contract.ts`. The run states come from
`docs/albatross-step-runner.md`. This note decides how the web thread looks and behaves. The iOS
and macOS notes decide their own surfaces.

Mockup: `/tmp/albatross-thread-mockup/index.html`. Renders at 1440×900, light mode:

- S9 + S10, the class form with the missing phone: `/tmp/albatross-thread-mockup/s9.png`
- S13, the final page handoff: `/tmp/albatross-thread-mockup/s13.png`

The sample data is invented (Sam Rivera, 555 numbers, example.com).

## 0. What the three screenshots show, and what this design removes

Jakob's screenshots show the Guided work page after a run, then the floating chat over it. Six
defects are visible on the page itself:

1. Three "Continue" buttons and two "Discuss this" buttons on one screen.
2. The same handoff sentence twice (the card and the browser bar).
3. The chat opens over the registration form that the user has to read.
4. The run says "only you can enter" for name and address. The chat says "Your details are saved".
   Neither is true.
5. The run and the chat are two voices with two memories.
6. The step list, the briefing, the card, the browser bar, and the chat each have their own frame.

The design below has one conversation, one run block per run, one primary action per block, and
one page pane beside the conversation. The chat does not float over anything on this page.

## 1. Research findings and the decision each one drives

### 1.1 Mobbin (web screens, images inspected)

| Screen | Taken | Rejected |
|---|---|---|
| Lindy, chat beside a Browser pane ([screen](https://mobbin.com/screens/9f4affd5-f387-4149-860e-95c83f9bbba5)) | The page is a sibling pane, not an overlay. A row in the chat ("Use Computer") opens it. The pane has one close control. | The "Browser / Terminal" tab strip. Albatross has one page. |
| Gumloop, "Asking for your input" form plus a Details panel ([screen](https://mobbin.com/screens/a0c0e7b0-88bb-4a89-904a-d88ee892a8dd)) | A one-line status above the form card. A right panel with Details and Files, and a "No files yet" empty state. | "Reject" on a question. We use "Skip". The credits meter. |
| Unify, question 4/4 with detail lines ([screen](https://mobbin.com/screens/66df7194-18ef-479e-9679-03955deba055)) | Option rows: bold label, one detail line. An "Other" text row inside the list. "Skip" as a quiet button beside the primary. | Paging (Previous / Next, "4 / 4"). One form asks everything at once. Keyboard number badges. |
| Obvious, option marked "Recommended" ([screen](https://mobbin.com/screens/c4e3df56-6a0d-42e2-ad0e-04b583839729)) | One option carries a tag. We write "Matches what you said". The "Wrapped up 2 actions" row before the question. | "Skip all". Multi-question paging. |
| Base44, plan card ([screen](https://mobbin.com/screens/1af86cad-8541-40c6-9999-c6d7e4147660)) | The plan is one compact card with one primary action. Ours is "Handle it". | "Read more" truncation of the plan. |
| Manus, done steps collapse to one row ([screen](https://mobbin.com/screens/c70c43d2-4f48-465d-b20b-65e118a57dce)) | A done run is one row with its text. The conversation stays the only column. | The "3 / 3" strip floating over the composer. Our plan line is in the header. |
| Relevance AI, "1 step performed in the background" ([screen](https://mobbin.com/screens/47029a5f-10c0-4e7e-a800-6591d1a26f91)) | A background run is a collapsed row with a relative time. The update follows as a normal message. | The "Save and re-run task" editor. |
| Unify, "Thinking 1m 26s · View all steps 4" ([screen](https://mobbin.com/screens/b582675c-92ec-417a-ae38-969fe3400d82)) | A duration beside the log trigger. "View all steps" becomes "What Albatross did · 6 lines". | A different glyph for each row. |
| Rox, "Step 1 of 7" header ([screen](https://mobbin.com/screens/107c729c-a68d-48e3-8ece-51d43eff4215)) | "Step N of M" as the plan line grammar. | The progress bar and "3 min left". A run has a limit, not an estimate. |
| Rox, Customer Details panel ([screen](https://mobbin.com/screens/c05306de-ff8e-46ed-bef7-ea404b389e29)) | Label and value rows with one "Edit" for the details panel. | An icon in front of each label. |
| Higgsfield, "Waiting for your approval" ([screen](https://mobbin.com/screens/b24bb921-1831-4757-b796-0b13589139c1)) | A status line above the card that says what Albatross waits for. | "Always allow". No standing permissions in PR 1. |
| Browserbase, run page ([screen](https://mobbin.com/screens/a70eca33-be2c-4a76-81e9-87c449d81d81)) | Time-stamped log lines. | "Reason" and "Tool" badges. |
| Mistral, "Researching… · Cancel" ([screen](https://mobbin.com/screens/181ce284-3dcd-4d44-bb1f-368d2e5db997)) | The stop control sits on the running block, not in the header. | The estimate. |
| Mercury, My Profile rows ([screen](https://mobbin.com/screens/1fe6fdaa-2682-4c6d-af96-88fae8753288)) | Label, value, and "Edit" under the value. "Preferred name" beside "Legal name" is the pattern for S23. | The toast style. |
| Grok, account rows with trailing buttons ([screen](https://mobbin.com/screens/7682e37b-75e7-48d2-8e61-127e42ae5fb2)) | One trailing button per row. | Different verbs per row ("Edit name", "Update email"). We use one verb, "Change". |
| Linear, profile inline edit ([screen](https://mobbin.com/screens/bfe0e59e-4274-4d4b-a2df-c6835fa43c0e)) | Edit in place with Cancel and Save. | The pencil icon. |
| Contra, step accordion with checks ([screen](https://mobbin.com/screens/2fce92f6-622a-46da-adb9-4e5e52858225)) | Done steps show a check and close. The current step is open. | The top stepper. |
| Neon, side-panel step cards ([screen](https://mobbin.com/screens/8c5d99e3-4d92-4df7-8b46-8f3b4651f160)) | The plan in a side panel: a check or a number per step. | The blue callout. |
| Emergent, "Agent is waiting…" in the composer ([screen](https://mobbin.com/screens/aaeb158c-7e4f-4b05-8de2-b23a35fc006e)) | Nothing. | A status inside the composer. The plan line carries the state. |

### 1.2 Reference products (Browserbase fetches)

- **Manus, take over** ([help article](https://help.manus.im/en/articles/11711218-how-can-i-take-over-manus-browser-or-vs-code)).
  "Manus will prompt users to take over when it requires assistance from them." The user can also
  take over at any time. Decision: "Take over" is always on the page pane while Albatross has the
  page. A handoff names what the user must do.
- **Manus, saved sign-ins** ([help article](https://help.manus.im/en/articles/11711226-how-can-i-manage-the-login-information-that-manus-stores)).
  After a manual sign-in, Manus asks whether to keep the login. Settings > Cloud Browser turns the
  feature off and manages sites. Decision: after the first sign-in handoff, Albatross says "The
  browser keeps this sign-in for next time." Settings keeps "Saved sign-ins" and "Forget saved
  sign-ins".
- **Claude in Chrome, permissions** ([guide](https://support.claude.com/en/articles/12902446-claude-in-chrome-permissions-guide)).
  A plan names the sites before work starts. The choices are "Allow this action", "Always allow
  actions on this site", and "Decline". It always asks before it enters sensitive information.
  Purchases and card or ID data are prohibited. Decision: personal details are typed without a
  prompt (owner decision). Payment, password, and one-time codes stay a handoff. Every prefilled
  value in a form card shows where it came from.
- **ChatGPT browser extension** ([docs](https://learn.chatgpt.com/docs/chrome-extension.md), official
  Markdown). It asks before each new website host: "Allow once", "Allow for this site", "Allow for
  all sites", "Decline". Page content is "untrusted context". A secondary write-up of the OpenAI
  help text ([chatgptaihub](https://www.chatgptaihub.com/chatgpt-work-cloud-browser-signed-in-websites-secure-login-permissions-confirmation-session-cleanup/))
  quotes the cloud browser rules: it continues after you leave the device, it "pauses when it
  needs missing information, a sign-in, or a confirmation", the sign-in screen goes to the user and
  the model never sees the password, and it prepares forms but does not submit them. Decision: our
  three pause kinds are the same three (`needs_answer`, `sign_in`, `finish_on_page`). The final
  handoff is a confirmation packet: what is filled in, what the user pays, one button.
- **Genspark Super Agent** ([help](https://www.genspark.ai/helpcenter/super-agent)). "Start it,
  close your laptop, and come back to finished work." Delivered files are cards in the chat and stay
  with the project. **Call For Me** ([help](https://www.genspark.ai/helpcenter/call-for-me)) returns a
  transcript and a summary into history, plus an email when the task ends. Decision: S5. A run that
  ran while the user was away shows the run, its summary, its files as cards, and the handoff at
  the bottom, in that order.
- **Perplexity Comet**: perplexity.ai returned a Cloudflare challenge (403), and the Intercom help
  host redirected to the same wall. No decision rests on Comet. **help.openai.com** was 403 too;
  the learn.chatgpt.com document stood in.

### 1.3 What the code already gives us (survey of the worktree)

- `AssistantChat` (`components/shell/AIBar.tsx:205`) has no prop for a session id or an attached
  Work. It reads `chatScope` from the global store. The thread must pass its scope by props, or the
  inert global instance in `AppShell.tsx:379` re-scopes and clears its messages.
- HITL tools answer through `addToolResult` (`AIBar.tsx:354-359`) and continue through
  `createHitlAutoContinueGuard` (`lib/albatross/teach-ui.ts:146-154`). `ask_form` joins
  `HITL_TOOL_NAMES` and gets a case in `HitlPart`.
- `groupMessageParts` (`lib/chat/work-log.ts:47-89`) folds tool parts into "Did N things". A
  `step_run` shape needs a standalone exception, or the run hides inside a collapsed log.
- The Odyssey chat container (`components/odysseyui/chat-container.tsx:60-84`) already follows
  the bottom and stops when the user scrolls up more than 64 px. The thread reuses it.
- No tool-ui part has a text, phone, email, address, or date input. The form card is new.
- `react-resizable-panels` v4 (`Group`, `Panel`, `Separator`) is in `AppShell.tsx`. No install.
- Settings tabs are three arrays (`teach-ui.ts:11-42`, `settings-nav.ts:14-41`,
  `app/settings/page.tsx:94`) plus two tests.

## 2. Layout spec

### 2.1 Regions

```
┌ rail ┬───────────────────────────────────────────────────────────────────────┐
│      │ Back  Outcome title            [Step 1 of 2 · Your turn]   Page Details More │  header 50px
│      ├──────────────────────────────────────┬──┬────────────────────────────┤
│      │ conversation column                  │  │ right region               │
│      │   messages, run blocks, forms        │se│   Page pane  or  Details   │
│      │   (max 660px, centred)               │am│                            │
│      │                                      │  │                            │
│      │ ┌ composer ────────────────────────┐ │  │                            │
│      │ └──────────────────────────────────┘ │  │                            │
└──────┴──────────────────────────────────────┴──┴────────────────────────────┘
```

1. **Header** (50 px). Left to right: "Back" (text), the outcome title (display font, 16 px, one
   line, ellipsis), the plan line (a bordered pill button, 12 px: "Step 1 of 2 · Your turn"). On the
   right: "Page" (only while a browser session exists), "Details", "More". The active right-region
   tab shows the control-hover fill. "More" opens a menu: Horizon (Now, Later, Someday), "Split this
   work", "Put it down", "Mark it complete". A done or released Albatross shows "Reopen" or "Pick
   it back up" instead.
2. **Conversation column**. The `AssistantChat` message list with the merged timeline. Content is
   centred at a maximum of 660 px. Padding 16 px top, 28 px sides.
3. **Composer**. The existing Prompt Input (attach, mic, Tab, Ask, send). No "Work:" chip on this
   page. The Hold route stays (it captures to a new Albatross, as today).
4. **Right region**. One region, two tabs: Page and Details. Only one is visible at a time.
5. **Seam**. The react-resizable-panels separator, 6 px, hairline on hover and drag.

### 2.2 Widths and breakpoints

| Range | Rail | Conversation | Right region | Notes |
|---|---|---|---|---|
| Desktop ≥ 1280 | 240 px (user may collapse to 48) | Flexible, minimum 520 px | Default 44 % of the surface, minimum 400 px, maximum 60 % | Both panes dock side by side. |
| Laptop 1024–1279 | Collapses to 48 px automatically when the right region opens; restores when it closes | Minimum 480 px | Default 46 %, minimum 380 px | The same split. |
| Tablet 768–1023 | 48 px | Full width | A sheet from the right, 92 vw, over the conversation | The sheet has "Back to the conversation" at the top. The conversation does not reflow. |
| Phone < 768 | Hidden (existing mobile sidebar) | Full width | Full-screen sheets | The header is two rows: title, then the plan line. The composer sticks to the bottom with the safe area. |

Rule: the page pane never covers the conversation on a desktop or laptop. The chat never covers
the page. That is the fix for screenshot 2.

### 2.3 How the page pane and the details panel share the right side

- One region. Two tabs in its header. The user switches with the header buttons "Page" and
  "Details", or with the tabs inside the region.
- **Auto-open**: when a run gets a browser session, the region opens on Page, unless the user has
  pinned Details in this visit. A pin is set when the user opens Details by hand.
- **Auto-close**: a region that a run opened closes when the session ends. A region the user opened
  stays until the user closes it.
- Details remembers its scroll position and open sections for the visit.
- There is no stacking of both panes. Wide screens do not change this rule.

### 2.4 Resize

- `Group` with two `Panel`s and one `Separator`. Layout saved in localStorage under
  `lab86-mail-thread-split` (desktop and laptop only).
- Keyboard on the separator: arrow keys 2 %, Shift + arrow 10 %, Home and End to the limits,
  Enter or double-click resets. This copies `AssistantWorkspace` so the two seams feel the same.
- The live-view iframe gets `pointer-events: none` while a drag is in progress, so the drag does
  not fall into the page.

### 2.5 Scroll anchoring

- The conversation follows the bottom while the user is within 64 px of it. It stops when the user
  scrolls up. It starts again when the user returns to within 64 px, or presses the round
  "Scroll to bottom" control. This is the current Odyssey container rule, unchanged.
- Run log growth and streamed text follow the same rule. A growing log never pulls the view down
  while the user reads history.
- When a form or a handoff arrives while the user is not following, a pill appears above the
  composer: "Albatross needs an answer" or "Ready for you". It scrolls to the item.
- On open, the view starts at the bottom (S1). A deep link to a run scrolls that run into view and
  leaves 16 px above it.

## 3. Component inventory

### 3.1 Reuse (do not fork)

| Piece | Where | How the thread uses it |
|---|---|---|
| `AssistantChat`, `MessageView`, the Part routing, `ChatPartContext` | `components/shell/AIBar.tsx` | The thread mounts `AssistantChat` with new props: `sessionId` (`workThreadSessionId(workId)`), `scope={{ kind: 'work', workId, label }}`, `chrome="thread"` (no header controls, no "Work:" chip, no restore-last-chat), and `timelineRuns` (the live run rows). The transport body carries `contextAttachments: [{ kind: 'work', id }]` as today. Export `ChatPartContext` so run blocks can answer. |
| Odyssey chat container, Message Bubble, Prompt Input, Thought Chain, Steps | `components/odysseyui/*` | Unchanged. User bubbles stay accent-tinted and right-aligned. |
| `WorkLog`, `groupMessageParts` | `components/ai-elements/work-log.tsx`, `lib/chat/work-log.ts` | Unchanged for ordinary tools. Add a standalone exception for `step_run` so a run block never hides inside "Did N things". |
| `Task`, `TaskTrigger`, `TaskContent`, `TaskItem` | `components/ai-elements/task.tsx` | The run log. Trigger text "What Albatross did · 6 lines". No leading icon. |
| `ShimmerText` | `components/odysseyui/text-shimmer` | The newest log line while a run works. |
| `HitlPart`, `AskUserForm` | `components/ai-elements/hitl-parts.tsx`, `choice-prompt.tsx` | `ask_form` gets a case that renders the form card. The receipt replaces the old summary. |
| `ShapeCard`, `DocumentCard`, `EventCard`, `ReceiptCard` | `components/ai-elements/shapes/*` | Run artifacts render as the same cards. Add cases for `step_run` and `personal_details_saved`. |
| `ApprovalCard`, `MessageDraft` | `components/tool-ui/*` | `approve` and `review_draft` handoffs. Labels set explicitly ("Approve the invite", "Read and send"). |
| `OutcomeHeader` facts, `ShapePicker`, `HorizonControl`, `SplitSheet`, `ReleaseSheet`, `LapsePrompt` | `components/albatross/primitives.tsx`, `WorkDetail.tsx` | Move to the header menu and the details panel. |
| `BriefCanvas` (plan document), `ProofTimeline`, `OutcomeContractCard`, the "What changed" list with Undo | `WorkDetail.tsx:1096-1228` | Move into the details panel sections. |
| `performNextBehaviour`, `openSavedDraft`, `openDocumentPath` | `lib/albatross/step-run-navigation.ts` | Unchanged. The run block's primary button calls them. |
| `stepRunPhase`, `handoffHeadline`, `stoppedLine`, `logLines`, `formatLogTime` | `lib/albatross/step-run-client.ts` | Unchanged. |
| `SectionHeading`, `SettingsCard`, `SettingsRow`, `SettingsNote` | `components/settings/primitives.tsx` | The Personal details tab. |
| `Sheet` | `components/ui/sheet.tsx` | The tablet and phone right region. |
| `Input`, `Select`, `Checkbox`, `Label`, `day-picker` | `components/ui/*` | The typed fields of the form card. |

### 3.2 New

| Component | File (proposed) | What it is |
|---|---|---|
| `WorkThread` | `components/albatross/WorkThread.tsx` | The page. Header, the resizable group, the right region, the thread chat. Replaces `WorkDetail` in `AppShell.PrimarySurface`. |
| `PlanLine` | `components/albatross/thread/PlanLine.tsx` | The header pill. States in §5.5. Click opens Details at Plan. |
| `RunBlock` | `components/albatross/thread/RunBlock.tsx` | One `ThreadRunView` in every state (§5.1). Mounted as a timeline item, or inside a message for a `step_run` shape. |
| `FormCard` | `components/ai-elements/form-card.tsx` | One `FormQuestion` in every state (§5.2). Used by `ask_form` and by a `needs_answer` handoff. |
| `FormReceipt` | same file | The answered, skipped, and expired states. |
| `DetailsSavedReceipt` | `components/ai-elements/shapes/DetailsSavedCard.tsx` | "Saved to your details: Phone" with "Undo". The `personal_details_saved` shape. |
| `PagePane` | `components/albatross/thread/PagePane.tsx` | The live view with its header (§5.3). Built from the iframe in `GuidedStep.tsx:359-365` and `browserPaneState`. |
| `DetailsPanel` | `components/albatross/thread/DetailsPanel.tsx` | Plan, Files, Proof, Commitments, Sources and assumptions, Plan document. |
| `ThreadRightRegion` | `components/albatross/thread/RightRegion.tsx` | The tab host. Split on desktop and laptop, `Sheet` below 1024. |
| `PersonalDetailsSection` | `components/settings/PersonalDetailsSection.tsx` | The settings tab (§4, S21). |
| `useThreadTimeline` | `lib/albatross/thread-timeline.ts` | Calls `mergeThreadTimeline` with `createdAt` from `metadata` and `startedRunIds` from `step_run` shapes. |

### 3.3 Delete

- `components/albatross/GuidedStep.tsx` (the Guided work page), with its 300 px step rail and the
  three browser states.
- The `StepRunPanel` card stack in `WorkDetail.tsx:1070-1094` and `StepRunPanel.tsx` itself. The
  run block replaces every state it rendered.
- The floating chat over the Work page: `openAttachedChat` (`WorkDetail.tsx:786-793`) and every
  "Discuss this" and "Answer in chat" button on this page. The composer is the chat.
- The "Find my next step" suggestion chip for the Albatrosses page
  (`lib/shell/assistant-context.ts:18,22,26`). The plan line and "Handle it" replace it.
- `WorkDetail.tsx` as a page. Its sections move; the file goes.

### 3.4 Registry installs

Searched with the shadcn MCP (`@ai-elements`, `@tool-ui`, `@kibo-ui`, `@shadcn`):

- No new install is required. `task`, `chain-of-thought`, `conversation`, `confirmation` from
  `@ai-elements` and `option-list`, `approval-card`, `message-draft`, `progress-tracker` from
  `@tool-ui` are already in the tree. `resizable` is not needed because the shell imports
  `react-resizable-panels` directly.
- No registry has a typed-field form (searches: "form", "question", "input"). `@tool-ui/question-flow`
  is choice-only with paging, and `@kibo-ui/dialog-stack` is a modal wizard. The form card is
  custom, built from the shadcn field primitives, and uses the `OptionList` keyboard model for its
  choice rows.
- Tool-ui defaults that break the copy rules must be overridden: "Save Changes", "Deny", "Clear",
  "Complete", and the check icon before receipt text.

## 4. User stories as screen states

All copy is sentence case, STE, and never says "AI", "assistant", or "agent". The plan line is
written as `Step N of M · State`.

**S1. Open from anywhere.** The thread opens scrolled to the bottom. If the newest item is a form
or a handoff, it sits directly above the composer. Loading: "Loading this Albatross…". Missing:
"This Albatross is no longer available." with "Back to Albatrosses". The deep link
`/?view=albatrosses&work=<id>` is unchanged. A `run=<id>` parameter scrolls that run into view.

**S2. A new Albatross.** First item, an assistant message with a plan block:

```
What Albatross understood
Outcome   Register for and complete the CPR and first aid course before November 14.
Plan      1  Register for the course                            Handle it
          2  Attend the lifeguard orientation on November 14          Yours, offline
```

While the plan is not ready: the block says "Albatross makes the plan." with a shimmer line, the
plan line says "Making the plan…", and the composer placeholder is "Add anything Albatross should
know". The composer works. A message sent now is attached to the plan request.

**S3. The plan at a glance.** Plan line: "Step 1 of 2 · Your turn". Click: the right region opens
on Details, Plan section:

```
1  Register for the course                     Now        Handle it
2  Attend the lifeguard orientation on November 14   Next
```

A done step: "✓ Register for the course · Verified on the page · Registration confirmed, order
A1234". A runnable step shows "Handle it". A step with an open run shows "Working" instead.

**S4. Older chats.** The adopted chat's messages appear at the top under a hairline divider that
reads "From an earlier chat · Oct 3". Older chats stay in the Chat page history. The thread does
not list them. The "More" menu has no history item.

**S5. Away and back.** Order on open: a hairline divider "While you were away", the run block
(collapsed log, summary), its file cards, then its handoff with its one button, directly above the
composer. The plan line says "Step 1 of 2 · Ready for you". The notification opens the same scroll
position. The "While you were away" divider needs a last-seen time; see §9.

**S6. Start.** "Handle it" (in the plan block or the Details plan) calls the run route directly.
No fake user message appears. The run block appears as a timeline item:

```
Step 1  Register for the course                      Working · 0:42    Stop
▾ What Albatross did so far · 3 lines
   10:39  Opened firstaidclass.example.com
   10:39  Read the class schedule: 3 virtual classes before November 14
   10:40  Checked your calendar for each class          ← shimmer
```

When the user writes "go ahead and register me", the chat calls `albatross_handle_step`, and the
same block renders inside that assistant message after its one line: "I will handle the
registration. I will stop before the $45 payment, which is yours to make."

**S7. Watch the page.** When the run gets a session, the right region opens on Page. Pane header:
"Albatross is on the page. Opening the registration form." with "Take over". If the user closed
the pane, the run block shows a page row: "firstaidclass.example.com · Albatross has the page" with "Open the
page". On a tablet or phone the same row opens the sheet.

**S8. Talk while it works.** The user writes "use the Monday class". The chat calls the tool with a
note. The assistant message is one line, "Noted. Albatross uses the Monday class.", followed by a
small `step_run` row in steered mode: "Sent to the run". The run log gains "10:41  Read your note:
use the Monday class". No second block appears.

**S9. A choice that is mine.** See `s9.png`. The run block: "Step 1 · Register for the course ·
Paused · 10:41", the collapsed log "What Albatross did · 6 lines", the summary "Found three virtual
classes before November 14 and opened the registration form to read its fields. Your name, email,
and address are ready. The class and your phone number are missing." Then the form card:

- Title "Which class?". Lead "All three are 4-hour Zoom sessions. Registration closes one week
  before each class."
- Field "Class", three option rows. Each row: the day, the detail line "4:00–8:00 PM · Zoom · $45",
  and the calendar line in the success voice ("Free on your calendar") or the warning voice
  ("Conflicts with Team sync, 5:00 PM"). The first row carries the tag "Matches what you said" and
  is preselected. Nothing else is preselected.

**S10. Missing details in the same form.** The same card continues with "For the registration
form": compact rows for Name "Sam Rivera · From your details", Email "sam.rivera@example.com · From
your account", Home address "12 Elm Street, Apt 3, Springfield, IL 62704 · From your details",
each with "Change". Phone is the only open input, placeholder "(555) 555-0100", help "The site sends
the Zoom invite by text message." Footer: the checked box "Save phone to my details", then "Skip"
(quiet) and "Continue" (primary). One submit.

**S11. Answer in my own words.** The user writes "Monday works, my phone is 607 555 0100". The
assistant answers in one line: "Monday, October 19 it is. Albatross continues." Under it, the
receipt "Saved to your details: Phone" with "Undo". The pending form card changes to its receipt
with the state "Answered in the conversation" and the two values. The run block continues.

**S12. Sign in.** Handoff block: headline "Your turn", detail "Sign in to firstaidclass.example.com in the
page, then press Continue." Buttons: "Continue" (primary), "Dismiss". Pane header: "Your turn.
Sign in to firstaidclass.example.com." The user may also write "done". After the resume, the log reads
"Checked the sign-in: signed in as sam.rivera@example.com" and Albatross adds one line: "Signed
in. The browser keeps this sign-in for next time."

**S13. The final page.** See `s13.png`. The continued block: summary "Filled in the registration
form for Monday, October 19 with your name, email, address, and phone. The $45 payment is yours to
make." Headline "Your turn". Detail "Everything is filled in. Check it and pay the $45." Buttons
"I paid" (primary) and "Dismiss". Pane header: "Your turn. Check the form and pay the $45." with
"Close the page". After "I paid", the block shows "Checking the page…" and then the done state with
its proof.

**S14. Drafts and documents.** Headline "Ready for you". A draft card: "Draft to the pool manager ·
Subject: CPR and first aid certificate", button "Read and send". A document card: "Completion
certificate.pdf", button "Open". The primary button of the block is the first artifact's action.

**S15. Done.** The block collapses to its done state: "Step 1 · Register for the course · Done ·
10:52", the proof line "Verified on the page · Registration confirmed, order A1234", and the log
trigger. One assistant line follows: "Next: attend the lifeguard orientation on November 14. This one is
yours. Albatross reminds you the day before." Plan line: "Step 2 of 2 · Next: Attend the lifeguard
orientation".

**S16. Failed or stopped.** Failed: "Step 1 · Register for the course · Did not finish · 10:52",
the line "This run did not finish. The site did not load after three tries.", button "Try again".
Stopped: "Albatross stopped at its time limit." with the summary and "Continue". Cost: "Albatross
stopped at its cost limit."

**S17. Ask.** "when is the orientation?" gets a normal answer with the work log ("Did 2 things ·
4s") and an `EventCard`. Nothing about the page changes.

**S18. Change the plan.** "I already registered, skip that." Albatross marks step 1 done with
reported evidence and answers: "Marked step 1 done. Next: attend the lifeguard orientation on November
2." A small receipt row reads "Step 1 marked done · Reported by you". The plan line updates.

**S19. Details.** The Details panel sections, top to bottom: Plan (the step list), Files (every
artifact with "Open" and "Undo" while the provider allows it; undone rows stay struck through),
Proof (the proof timeline), Commitments (the outcome contract), Sources and assumptions
(collapsed), Plan document ("Read the plan", collapsed, opens the `BriefCanvas`). Split, Put it
down, the horizon, and "Mark it complete" are in the header "More" menu.

**S20. It knows me.** No question appears. The log reads "10:44  Typed your name, email, and home
address". The summary says which details it typed.

**S21. Settings.** Settings gains the tab "Personal details" in the You group, before Account.
Heading "Personal details", blurb "Albatross types these into forms for you. It never keeps
passwords, card numbers, or ID numbers here." Aside: "4 saved". Rows:

```
Name              Sam Rivera                                   Change
                  You changed this on Oct 7 · Account name: Sam rivera
Email             sam.rivera@example.com                       Change
                  From your account
Phone             (555) 555-0100                               Change   Delete
                  You told Albatross on Oct 7
Home address      12 Elm Street, Apt 3, Springfield, IL 62704   Change   Delete
                  From a form on Oct 7
Emergency contact Not saved                                    Add
```

Below the card: "Add a detail" (a label and a value, for plain facts such as "Employer"). Editing
happens in place with "Cancel" and "Save". Delete shows the toast "Phone deleted" with "Undo".

**S22. Found in my mail.** The form card's Phone row is prefilled "(555) 555-0100" with the source
"From your email signature" and the checked box "Save phone to my details". Submit saves it. The
runner never types a found value without this form.

**S23. My legal name.** In Personal details the user changes Name to "Sam Rivera". The row's
hint reads "You changed this on Oct 7 · Account name: Jakob langtry". Forms use the saved name.
The account name does not change.

**S24. Something it must not keep.** The user writes a Social Security number. Albatross
answers: "Albatross does not keep that number here. Type it into the site yourself when a form asks
for it." No receipt appears, and the number is not in Personal details.

## 5. State matrices

### 5.1 Run block

Anatomy: header row (step number and title on the left; state and time on the right), the log
(`Task`), the summary, the page row (optional), the handoff (headline, detail, artifacts), the
action row. The block sits on the paper with a hairline border. Cards inside it are raised.

| State | Header right | Log | Body | Actions |
|---|---|---|---|---|
| queued | "Waiting to start." | hidden | – | "Stop" |
| running | "Working · 0:42" (shimmer on the newest line) | open, newest last, inner scroll at 240 px pinned to the newest line | – | "Stop" |
| running, note read | same | the line "Read your note: …" in the accent-3 voice | – | "Stop" |
| handed_off · needs_answer | "Paused · 10:41" | collapsed "What Albatross did · N lines" | summary, then the form card | the form's own "Continue" and "Skip" |
| handed_off · your_turn · sign_in | "Paused · 10:41" | collapsed | summary; headline "Your turn"; detail from the run | "Continue" primary, "Dismiss"; "Open the page" only when the pane is closed |
| handed_off · your_turn · finish_on_page | same | collapsed | summary; "Your turn"; detail | `next.label` primary ("I paid", "Check and submit"), "Dismiss"; "Open the page" when the pane is closed |
| handed_off · your_turn · do_offline | same | collapsed | summary; "Your turn"; detail | "Mark this step done" primary, "Dismiss" |
| handed_off · ready_for_you · review_draft | "Ready · 10:41" | collapsed | summary; headline "Ready for you"; draft card | "Read and send" primary, "Dismiss" |
| handed_off · ready_for_you · review_document | same | collapsed | summary; document card | "Open the document" primary, "Dismiss" |
| handed_off · ready_for_you · approve | same | collapsed | summary; `ApprovalCard` | "Approve the invite" primary, "Dismiss" |
| handed_off · ready_for_you · review | same | collapsed | summary; artifacts | "Open" primary, "Dismiss" |
| handed_off · stopped (time) | "Stopped · 10:54" | collapsed | "Albatross stopped at its time limit." then the summary | "Continue" primary, "Dismiss" |
| handed_off · stopped (cost) | same | collapsed | "Albatross stopped at its cost limit." then the summary | same |
| done | "Done · 10:52" | collapsed | the proof line "Verified on the page · …" or "Confirmed · …" | none |
| failed | "Did not finish · 10:52" | collapsed, open on click | "This run did not finish." plus `error` | "Try again" |
| cancelled (user pressed Stop or Take over) | "Stopped by you · 10:50" | collapsed | summary if any | "Handle it" |
| closed (dismissed) | "Closed · 10:50" | collapsed | summary | "Handle it" |
| continued chain | the new run renders as its own block directly under the parent with the label "Continued" on the top edge; the parent keeps its receipt | – | – | – |

### 5.2 Form card

| State | Title row | Fields | Footer |
|---|---|---|---|
| pending | title, lead | all fields editable; bound fields with a saved value render as compact rows with "Change"; unbound and empty fields are open inputs | "Save … to my details" when a bound value is new or different (checked), "Skip", submit label (default "Continue") |
| prefilled by the run (`value`, `valueSource`) | same | the field is open and filled; the source line under it ("From your email signature") | same, the save box checked |
| validation error, on submit | same | the first invalid field gets focus; the error line under it in the danger voice | buttons stay enabled |
| submitting | same | fields read-only | "Saving…", "Skip" hidden |
| answered | title, "Answered 10:44" | label and value rows, one per field | "Saved to your details: Phone" with "Undo" when a save happened |
| answered by chat | title, "Answered in the conversation" | the values the chat extracted; a missing value shows "—" | same |
| dismissed (skipped) | title, "Skipped" | hidden | "Answer now" (quiet) while the run is still parked on it |
| expired or superseded | title, "No longer open" | hidden | none |

Validation text by field kind:

| Kind | Error |
|---|---|
| choice | "Choose one option." / "Choose at least one option." / "Choose at most N options." |
| text | "This field is required." |
| number | "Enter a number." |
| phone | "Enter a phone number with at least 7 digits." |
| email | "Enter an email address like name@example.com." |
| date | "Enter a date." (the picker prevents most errors) |
| name | "Enter a first name and a last name." |
| address | "Enter the street, city, state or region, and postal code." |
| contact | "Enter a name and a phone number." |

### 5.3 Page pane

| State | Dot | Line | Actions |
|---|---|---|---|
| Albatross has the page (`agent`) | accent, soft ring | "Albatross is on the page. {statusDetail}" | "Take over" |
| Paused for an answer (`user`, next = answer) | faint | "Paused. Albatross continues after your answer." | "Take over" |
| Your turn (`user`, next = sign_in or finish_on_page) | success | "Your turn. {next.detail}" | "Close the page" |
| Checking (`verifying`) | accent, pulse | "Checking the page…" | none |
| Opening (`starting`) | accent | "Opening a shared browser…" | none |
| Closed (`ended`) | – | empty state "The page is closed." | "Open the page again" when the step has a URL |
| Error (`failed`) | danger | "The page could not open." | "Try again" |

The URL row shows the host and path in mono, read-only. There are no browser navigation buttons.
"Take over" cancels the run (PR #319 behaviour). The pane's "Hide" is the header "Page" toggle.

### 5.4 Thread

| State | Plan line | Composer placeholder | Last item |
|---|---|---|---|
| planning | "Making the plan…" | "Add anything Albatross should know" | the plan block, in progress |
| needs answers (a pending question) | "Step 1 of 2 · Needs your answer" | "Answer here, or tell Albatross what to change" | the form card |
| ready (no run, a runnable step) | "Step 1 of 2 · Your move" | "Tell Albatross what to do" | the plan block or the last message |
| running | "Step 1 of 2 · Working" | "Tell Albatross what to do" | the running block |
| waiting (handoff) | "Step 1 of 2 · Your turn" or "· Ready for you" | "Tell Albatross what to do" | the handoff block |
| done | "Done" | "Ask about this Albatross" | the proof line and the closing message "Finished. This one is off your list." |
| put down | "Put down" | "Ask about this Albatross" | "You put this down. That is one less thing." with "Pick it back up" in the header menu |

## 6. Edge cases

- **Two devices.** The thread session saves by merge on message id (the server rule). The Convex
  run query is live, so a run block on the second device updates without a reload. A form
  answered on one device turns into its receipt on the other within one query tick; a submit that
  races loses with the toast "Already answered on another device."
- **Very long runs (30 log lines).** The open log caps at 240 px with an inner scroll pinned to the
  newest line. "What Albatross did so far · 30 lines" stays the trigger. Lines older than 30 are
  not kept (the contract), and the trigger says "newest 30 lines".
- **Many runs.** The timeline shows the newest 30 runs. Done blocks collapse to one row each. A
  divider "Earlier runs are in Details" sits above the oldest shown run. Details · Proof lists
  every run's proof.
- **A run starts while the user reads history.** The view does not move. The pill "Albatross
  started on step 1" appears above the composer and scrolls to the block.
- **An old chat adopted as the thread.** Messages without `createdAt` sort first under the
  "From an earlier chat" divider. A `step_run` shape in them cannot exist, so no inline run is lost.
- **No plan yet.** The plan line says "Making the plan…". "Handle it" is absent. The Details panel
  shows "The plan is not ready." under Plan. The composer works.
- **Work done.** The header menu shows "Reopen". Run controls are hidden. The composer still
  answers questions (S17). The page pane cannot open.
- **Keyboard-only use.** Tab order: Back, title (skipped), plan line, Page, Details, More, the
  conversation (messages are a list; the form card's fields and buttons are in DOM order), the
  composer. The separator is focusable with the arrow rules in §2.4. Escape in an empty composer
  does nothing on this page (there is no floating chat to close). In the Details sheet, Escape
  closes the sheet.
- **Screen reader.** The run block is a `section` named by its step title. Its state line is
  `aria-live="polite"`. The log is a list with a time and a text per item. A new form card
  announces "Albatross needs one answer: Which class?". A handoff announces its headline and
  detail. The page pane is a `complementary` landmark named "Page: firstaidclass.example.com". The plan line
  is a button named "Plan, step 1 of 2, your turn".
- **Reduced motion.** No shimmer; the newest log line uses the text "Working". No slide on new
  messages. The pane opens without a transition.
- **Dark mode.** Every colour comes from the depth ladder tokens. The success and warning voices
  on calendar lines use `--color-success` and `--color-warning`, which have dark values. The
  live-view iframe keeps the site's own colours; the pane body sits on `--color-surface-well`.

## 7. The global chat on this page

- The thread is the chat. The floating `AssistantChat` does not open over `WorkThread`.
  `assistantLauncherPlacement` returns `hidden` on this page, `setSelectedWorkId` sets
  `aiBarOpen: false`, and the thread never calls `setChatScope`.
- ⌘K / Ctrl+K on this page focuses the thread composer. It does not toggle the floating chat.
- `askAssistant`, `captureOpen`, and brief handoffs that target this Work route into the thread
  composer. Ones that target another scope leave the page first.
- The rail's "Chat" item still opens the global Chat view, which is a different page. In that view,
  the "Work: <label>" chip is a link that opens the thread.
- When the user leaves the thread, the previous assistant presentation is restored
  (`pageNavigationAssistantState`), so a split chat on Mail comes back as it was.

## 8. The mockup

- Source: `/tmp/albatross-thread-mockup/index.html` (one file, two screens, switched by
  `?screen=s9` or `?screen=s13`). Tokens are copied from `app/globals.css` (the light defaults:
  accent hue 156, depth spread 1, tint 0). Fonts are the repo's Geist and Fraunces files.
- Renderer: `/tmp/albatross-thread-mockup/shoot.mjs` with `playwright-core` from the worktree and
  the Playwright Chromium build (1243). 1440×900 at 2×.
- `s9.png`: the S9 + S10 moment. The conversation is scrolled to its newest item, so the form
  sits above the composer. The page pane shows the empty registration form and the line "Paused.
  Albatross continues after your answer." with "Take over".
- `s13.png`: the S13 moment. The answered form is a receipt inside the first block. The continued
  block carries "Your turn", "Everything is filled in. Check it and pay the $45.", and "I paid".
  The page pane shows the filled form, the empty card fields, and "Close the page".
- Two iterations were made: the column now anchors to the bottom, the pane line fits on one line,
  the run header reads "Step 1 · title · state · time", and S13 keeps the S9 history above it.

## 9. Open questions for the lead designer

1. **A "recommended" flag on `FormOption`.** The contract has `label`, `detail`, and `calendar`
   but no way to mark the option that matches what the user said. Recommendation: add
   `recommended?: boolean` and render the tag "Matches what you said". Without it the runner must
   put the phrase into `detail`, which mixes voices.
2. **Preselect the recommended option?** Recommendation: yes. The selection is visible, "Continue"
   is explicit, and the payment is a separate handoff. Never preselect when no option is
   recommended.
3. **"Check the page" on the pane.** PR #319 kept it as a user control. Recommendation: remove it
   from the pane. "I paid" and "Continue" trigger the run's own check. A user who wants only a
   check writes "check the page".
4. **"Dismiss" on handoff blocks.** Recommendation: keep "Dismiss" (it matches the `dismiss`
   action). The alternative "Not now" reads softer but hides what it does.
5. **Tablet: sheet or split?** Recommendation: a sheet at 768–1023. A 50/50 split at 800 px makes
   both halves unreadable, which repeats the screenshot-2 defect in a new form.
6. **"Handle it": run route or chat tool?** Recommendation: the run route, directly. No fake user
   message. The block is a timeline item. Only a typed instruction goes through the chat tool.
7. **"While you were away" divider.** Needs a per-session `lastSeenAt`. Recommendation: ship the
   divider in a follow-up; S5 works without it because the handoff is still the last item.
8. **Header "Page" toggle.** Recommendation: keep it. It is the only way to reopen a pane the user
   closed while the session is still alive.
9. **Adopted chat divider.** Recommendation: show "From an earlier chat · <date>" above adopted
   messages, so the user understands a changed voice or an older plan in those messages.
10. **Composer placeholder.** Three variants by state (§5.4). Recommendation: keep three. One
    neutral placeholder loses the "answer here" hint that S11 depends on.
11. **Plan document in Details.** Recommendation: keep it, collapsed under "Read the plan". It
    stays useful for long plans, but it should not sit above the step list.
12. **Personal details tab placement.** Recommendation: the You group, before Account, with the
    description "What Albatross types into forms".
13. **Choice rows: `OptionList` or custom?** `OptionList` has no slot for a calendar line or a tag.
    Recommendation: custom rows with the `OptionList` keyboard model (arrow keys, space, Enter),
    so the thread keeps the registry-first rule in spirit without a fork.
14. **Steer receipt in chat.** A steered note renders as a one-line `step_run` row ("Sent to the
    run"). Recommendation: keep it one line, no card, so S8 shows "no second agent".
