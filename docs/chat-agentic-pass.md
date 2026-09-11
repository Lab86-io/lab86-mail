# Chat agentic pass

Date: 2026-09-11. Owner: Codex, continued from Claude. Scope: web, iOS, and macOS chat.

This document is the contract for the chat window work. Every platform
implements the same three things: the live work log, the result shapes, and
the text reveal. Platform code may differ. The behavior may not.

## 1. What changed on the server

- The agent turn streams. `lib/ai/loop.ts` runs `streamText` and forwards
  every chunk as it happens: text deltas, reasoning deltas, tool input start
  and deltas, tool output, sources, and errors.
- A runtime that fails before it sends content is dropped and the next runtime
  in the chain starts. An error after content is written through as an
  `error` chunk. The client keeps the partial reply and offers Continue.
- Each tool result is followed by a data part: `{ type: 'data-tool-shape',
  id: <toolCallId>, data: ToolShape }`. The shape is resolved by
  `lib/ai/tool-shapes.ts`. It is the only source of truth for cards. Clients
  do not re-derive cards from raw tool output, except for the existing
  `show_*` tools, which keep their designed components.
- Reasoning effort is low, tool calls run in parallel, and the prompt asks the
  model to write one short sentence before a batch of tool calls.

## 2. The live work log

Consecutive tool parts inside one assistant message form one work log block.
The block is the Manus and Notion pattern: a vertical rule on the left, one row
per tool call, and a header that reads the state of the group.

Header states:

| State | Header text | Indicator |
| --- | --- | --- |
| A tool runs | `Working` | The leading indicator (see section 4) |
| All tools done, reply streams | `Did N things` | none |
| Turn finished | `Did N things · 6s` | none, header is a disclosure |
| A tool failed | `1 step failed` | danger color on the failed row |

Rows:

- One row per tool call. The row text is the activity sentence from
  `toolActivityLine` on web and `describeTool` on native. Native adopts the
  web sentence grammar in this pass (see section 6).
- A running row shows the sentence in muted text with the same leading
  indicator as the text reveal, at the row's left edge inside the rule.
- A done row shows a small check glyph and the sentence in faint text.
- A failed row shows the sentence and the failure detail in danger text.
- While a tool's input streams, the row already shows the tool sentence with
  whatever arguments have arrived. It does not wait for the full input.
- When the tool has a shape (section 3), the card renders directly under its
  row, inside the rule. When the tool is a `show_*` tool, the designed
  component renders there instead.

Collapse rule: after the turn finishes, a block with three or more rows and no
failure collapses to its header. A tap or click expands it. A block with a
failure stays open. A block with one or two rows stays open.

Reasoning parts render as one collapsed line above the reply: `Thought`
while streaming, `Thought for 3s` once done. A tap expands the text in muted
type. Reasoning never renders as the reply.

## 3. Result shapes

`lib/ai/tool-shapes.ts` maps a tool name and its output to one shape. The
shape carries the display fields and the actions the platform can offer. Each
platform renders one view per shape kind. Nothing is per tool.

Shape kinds:

| Kind | What it shows | Actions |
| --- | --- | --- |
| `threads` | Up to 8 mail rows: sender, subject, date, snippet, unread | open, archive, snooze |
| `thread` | One mail card: sender, subject, date, excerpt, counts | open, reply, archive, snooze |
| `events` | Up to 8 calendar rows: title, time span, location | open, rsvp |
| `event` | One event card: title, span, location, attendees, calendar | open, rsvp, delete |
| `slots` | Free time slots from suggest or free-busy | hold (create event) |
| `tasks` | Up to 8 task rows: title, column, due, priority | open, complete |
| `task` | One task card: title, description, column, due, labels | open, complete |
| `board` | Board summary: title, columns with counts | open |
| `work` | Work card: title, shape, horizon, current step, progress | open |
| `works` | Up to 8 work rows | open |
| `area` | Area card: name, kind, domain, description | open |
| `document` | Document card: title, kind, revision, status, open path | open, publish link |
| `files` | Up to 8 cloud file rows: name, kind, source | import |
| `contact` | Person card: name, email, last contact, message counts | open threads, remember |
| `count` | One number with its label and query | none |
| `receipt` | What a mutation did: summary, surface, target, undo id | undo, open target |
| `sources` | Web or connector results: title, url, snippet | open url |
| `text` | Short summary text for tools with no other shape | none |

Common fields on every shape: `kind`, `title` (short), `summary` (one
sentence, optional), `actions` (array), and `account` when the shape is bound
to a mail account.

Action contract:

```ts
type ShapeAction =
  | { kind: 'open_thread'; account: string; threadId: string }
  | { kind: 'reply_thread'; account: string; threadId: string }
  | { kind: 'archive_thread'; account: string; threadId: string }
  | { kind: 'snooze_thread'; account: string; threadId: string; messageId?: string }
  | { kind: 'open_event'; account: string; calendarId?: string; eventId: string; startIso?: string }
  | { kind: 'rsvp_event'; account: string; calendarId?: string; eventId: string }
  | { kind: 'delete_event'; account: string; calendarId?: string; eventId: string }
  | { kind: 'hold_slot'; account?: string; startIso: string; endIso: string; title?: string }
  | { kind: 'open_task'; boardId?: string; cardId: string }
  | { kind: 'complete_task'; cardId: string }
  | { kind: 'open_board'; boardId: string }
  | { kind: 'open_work'; workId: string }
  | { kind: 'open_area'; areaId: string }
  | { kind: 'open_document'; documentId: string; path?: string }
  | { kind: 'open_url'; url: string; label?: string }
  | { kind: 'import_file'; connectionId: string; fileId: string; mimeType?: string }
  | { kind: 'undo_operation'; operationId: string }
  | { kind: 'remember_sender'; email: string };
```

Execution per platform:

- Web: navigation actions use the client store (`setPrimaryView`,
  `setSelectedThread` with `setThreadAccount`, `setPendingOpenWorkId`,
  `setCalendarSearchTarget`, the `lab86-mail:files-navigate` event). Mutation
  actions call the registry through `callTool` (`archive_thread`,
  `snooze_thread`, `tasks_update_card`, `calendar_rsvp_event`,
  `calendar_delete_event`, `calendar_create_event`, `undo_operation`,
  `google_file_import`, `remember`). After a mutation the card shows the
  outcome inline and does not leave the chat.
- iOS and macOS: navigation actions use the app environment and the existing
  sheets (thread sheet, Work detail, Files, calendar day). Mutation actions go
  through the mobile v1 command bus where a command exists (`mail.archive`,
  `mail.snooze`, `task.setCompleted`, `calendar.create`). Where no command
  exists (`undo_operation`, `calendar_rsvp_event`, `calendar_delete_event`,
  `google_file_import`, `remember`), the native client posts to
  `/api/tools/<name>` with the bearer token, the same route the web uses.

Card design rules (all platforms):

- One card per shape. Rows in a list are dense, single line where possible,
  with the same typography as the mail list and calendar rows on that platform.
- At most two actions visible. The first action is the primary one in the
  table above. More actions go behind a menu.
- Actions are text buttons. No icons before text. No stars, no sparkles.
- A card never repeats what the reply text already says. The reply sentence is
  short; the card carries the content.
- The card uses the platform's paper and elevation tokens. Web uses the
  existing tool-ui shell classes. Native uses `surfaceCard`.

## 4. The text reveal

Text arrives in chunks of several words. The client meters it out so words
appear one at a time, and a leading indicator sits just past the last word.

Metering:

- Keep a buffer of text received and a cursor of text revealed.
- Release words at a base cadence of 18 ms per word. When the backlog is over
  40 words, release faster so the reveal never lags more than about 600 ms
  behind the stream. When the stream finishes, release the rest within 400 ms.
- Reduced motion: no metering, no animation, text appears as it arrives.

Word motion: the route chip flip, from `components/shell/RouteChip.tsx`. The
word rises from 6 px below with opacity 0 to its place with opacity 1, over
150 ms, with the easing `cubic-bezier(0.165, 0.84, 0.44, 1)`.

Leading indicator: a small round dot in the accent color, 6 px, inline after
the last revealed word. It pulses on a 1.2 s cycle. It moves with the text and
disappears when the reply finishes. The same dot is the running indicator in
work log rows and the block header. It replaces the three typing dots and the
ellipsis symbol effect in the chat. The `Loader` typing variant stays for
other surfaces.

Platform notes:

- Web: `components/ui/markdown.tsx` gains the metered text. Streamdown's
  word animation is kept and pointed at a new `sd-rise` keyframe in
  `app/globals.css` that copies the chip motion. The indicator is a
  `::after` on the last block of the streaming markdown container.
- Web components come from the configured registries, not from scratch: the
  work log is built on `@ai-elements/chain-of-thought` and `@ai-elements/tool`,
  the running header text uses a shimmer from `@ai-elements` or `@loading-ui`,
  and the reasoning line stays on the existing prompt-kit reasoning component.
  Installed items are restyled to the app tokens and never forked.
- iOS and macOS: `SwiftStreamingMarkdown` keeps parsing. The view feeds it
  the metered text, not the raw buffer. The word transition uses
  `.transition(.offset(y: 6).combined(with: .opacity))` with the same curve.
  The indicator is a `Circle` overlay anchored to the trailing edge of the
  last text run.

## 5. Native gaps closed in this pass

- `ask_user`, `ask_parameters`, `ask_preferences`, and `ask_question_flow`
  render and answer on iOS and macOS. Today they stall the turn.
- `tool-output-error` renders as a failed row. Today it is dropped.
- `reasoning-*` parts render as the collapsed `Thought` line.
- Every non-`show_*` tool leaves a row in the transcript and restores from
  history.
- `show_table` no longer truncates to three columns. `show_weather` renders
  the structured payload. Map, code diff, and terminal reuse the brief node
  views.

## 6. Shared sentence grammar

Native adopts the tool sentence grammar from `lib/albatross/teach-ui.ts`.
The server sends the resolved sentence with the shape so native does not
need its own copy: `ToolShape.activity` holds `{ running, done, failed }`.
Native reads `activity` from the shape when present and falls back to
`describeTool` before the shape arrives.

## 7. Verification

- Web: `bun test`, `bun run lint`, `bun run typecheck`, `bun run build`, and a
  screenshot of a turn with three tool calls, one card, and streamed text.
- iOS: simulator build with `LAB86_INFO_*` from `Local.xcconfig`, one turn
  with a card and one turn with `ask_user`.
- macOS: the `Lab86MailMac` target builds, the panel and the torn-out window
  both show the work log and a card.
- The turn-level tests in `tests/agent-loop-helpers.test.ts` cover the
  forwarder. `tests/tool-shapes.test.ts` covers every shape kind.

## Recovery and validation

See [the recovery research notes](research/chat-revamp-2026-09-11.md) for the recovered work and evidence.
The final changes go directly to staging. The user requested CI validation instead of local test runs.
