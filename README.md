# lab86-mail · v0.8

Hosted mail client for Lab86's B2C mail product.

- **Backend:** single Next.js 16 + React 19 app, run on **Bun**. Runtime infrastructure is Railway + Clerk + Convex + Nylas + Clerk Billing.
- **AI:** OpenAI **GPT‑5.5** (primary) via Vercel **AI SDK 6**, with `@ai-sdk/anthropic` available as a fallback. API key is shared with `voice-agent` via `/home/jjalangtry/.config/lab86-private/voice-agent.env`.
- **Tools:** ~53 typed, Zod-validated tools in `lib/tools/*`. Every UI action and every AI agent action go through the same registry. Introspectable via `GET /api/tools` and callable via `POST /api/tools/<name>`.
- **Frontend:** shadcn/ui primitives, Motion 12 transitions, Lucide + Phosphor icons, TipTap (planned for compose), cmdk palette, Sonner toasts, next-themes, TanStack Query, Zustand.
- **Mail access:** Nylas is the interim provider transport for connected Google, Microsoft, iCloud, and IMAP accounts.

## Run

```bash
# dev
PORT=18836 HOSTNAME=127.0.0.1 bun run dev

# prod (used by lab86-mail.service)
bun run build
bun run start
```

Open `http://127.0.0.1:18836/` for local development.

## Hosted release

- `staging` deploys to Railway `development` at `https://web-development-292e.up.railway.app`.
- `main` deploys to Railway `production` at `https://web-production-3ec2.up.railway.app` until final DNS cutover.
- Production releases start at `0.8.0`; CI bumps patch by default, `[MINOR]` for minor, and `[MAJOR]` for major.
- Runtime variables live in Railway. GitHub stores only deploy and release credentials.
- See `docs/hosted-release-runbook.md` for DNS, rollback, and backup details.

## Favicon

The mail favicon is based on Iconify's Feather `fe:mail` icon by Megumi Hano,
licensed MIT with commercial use allowed and no attribution required:
`https://icon-sets.iconify.design/fe/mail/`.

## Accounts

- `jjalangtry@gmail.com` — direct.
- `jakob@lab86.io` — primary, holds forwarded / imported mail. (auth pending.)

## Service

```bash
systemctl --user status lab86-mail.service
systemctl --user restart lab86-mail.service
```

`lab86-mail.service` runs `bun run start` and pulls env from both:

- `/home/jjalangtry/.config/lab86-mail/lab86-mail.env` — service-local overrides (port, model names).
- `/home/jjalangtry/.config/lab86-private/voice-agent.env` — `OPENAI_API_KEY` shared with the voice agent.

## Architecture

```
app/                       Next.js App Router
  api/healthz/route.ts     basic health (model + accounts + tool count)
  api/tools/route.ts       GET → JSON schemas for every tool (Codex consumes this)
  api/tools/[name]/route.ts POST → invoke any tool by name
  api/agent/route.ts       UIMessage SSE stream — Vercel AI SDK 6 loop with all tools
  page.tsx                 RSC entry → <AppShell />
lib/
  tools/                   the single source of truth
    registry.ts            defineTool + invokeTool (audit-logged)
    mail.ts                read tools (search, get_thread, get_message, list_labels, ...)
    mail-mutate.ts         archive/trash/label/snooze/star/mark_read/...
    compose.ts             send/reply/forward/draft/schedule_send/undo_send
    ai.ts                  summarize_thread/triage_thread/draft_reply/bulk_triage/nl_search/...
    memories.ts            remember/recall/forget/list_memories
    calendar.ts            free_busy/suggest_times/create_event
    contacts.ts            contact_lookup/expand_alias
    web.ts                 browserbase_search/browserbase_fetch
    audit-tools.ts         log_action/list_audit
    index.ts               registry export — 53 tools total
  ai/
    client.ts              createOpenAI / createAnthropic, picks primary + fast models
    system-prompt.ts       agent persona
    loop.ts                streamText({ model, tools, stopWhen }) lifting registry → SDK
  store/                   local cache collections used by current UI workflows
  nylas/                   interim provider transport + normalization
  send/                    in-memory queue used by undo_send
  shared/                  Thread/Message/Memory types + date/format helpers
  client-state.ts          Zustand store
  api-client.ts            typed RPC over /api/tools/[name]
components/
  ui/                      shadcn primitives (Button, Input, Dialog, Tabs, ScrollArea, Command, ...)
  shell/                   AppShell, Rail, AIBar, ThemeSwitcher, ShortcutsSheet, ShortcutsBinding
  inbox/                   virtualized list with multi-select + bulk AI triage
  thread/                  stacked conversation cards + AI summary card + inline reply
  compose/                 ComposeDialog
  palette/                 CommandPalette (cmdk)
```

## AI bar

Press `⌘K` (or click the pill at the top) to open the always-available agent. It uses all 53 tools — search, mutate, draft, send, schedule, calendar, contacts, browserbase research, memory. The AI has the same capabilities as a human clicking in the UI; mutating tools surface as confirmation cards before they fire.

## Keyboard

`j/k` next/prev · `o` open · `u/esc` close · `e` archive · `#` trash · `r` reply · `c` compose · `/` focus search · `s` summarize · `t` triage · `g i/u/s/d/t/a` mailbox jumps · `⌘K` AI bar · `⌘P` palette · `?` shortcut sheet.

## The 35-item brainstorm

See `/home/jjalangtry/.claude/plans/think-of-35-ways-zany-starlight.md` for the master plan. v2 ships ~30 of the 35 by virtue of the tool registry being the action surface; the rest layer in trivially.
