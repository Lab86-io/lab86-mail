# Albatross

Albatross is Lab86's mail and personal-work assistant. This repository contains the Next.js web app, its Convex backend, and native iOS/macOS clients.

The web app brings together connected mail, calendar, Areas, Albatross work plans, a Daily Brief, files and document editors, notifications, and an assistant that acts through a shared tool registry. Today opens the Daily Brief; saved navigation links still select their destination.

## Local development

Use **Bun 1.3.11**, matching `package.json` and CI. Node.js is also used by repository tooling.

```bash
bun install --frozen-lockfile
cp .env.example .env.local
```

Configure `.env.local` for your development services:

| Service | Configuration |
| --- | --- |
| Convex | `NEXT_PUBLIC_CONVEX_URL` and `LAB86_CONVEX_INTERNAL_SECRET`. Set the same internal secret on the Convex deployment. |
| Clerk | `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY`. Configure the Clerk `convex` JWT template and set `CLERK_JWT_ISSUER_DOMAIN` on Convex. |
| App origin | Set `LAB86_MAIL_PUBLIC_URL=http://localhost:3000` for local callbacks. |
| Mail | Nylas credentials and webhook configuration from `.env.example`. Users connect their own provider accounts through the app. |
| AI | At least one of `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, or `ANTHROPIC_API_KEY`. The runtime prefers OpenRouter, then OpenAI, then Anthropic. |

[`.env.example`](.env.example) also documents optional cloud-file OAuth, push notifications, billing, and embedded Office editing. [The hosted setup runbook](docs/hosted-release-runbook.md) covers provider configuration.

Start Convex against your development deployment and run the app in a second terminal:

```bash
bun run convex:dev
```

```bash
bun run dev
```

Open **http://localhost:3000**. To use another port, add `-p`, for example `bun run dev -p 18839`, and update `LAB86_MAIL_PUBLIC_URL` to match. Bind to `localhost`, not `127.0.0.1`: with `127.0.0.1`, Next 16 dev cannot proxy page renders.

### UI preview

`bun run dev:preview` runs the app workspace with synthetic data at **http://127.0.0.1:18847**. It reads compiled fonts from `.next/static/chunks`, so run the Next app or build it first. Preview fixtures and browser verification scripts live in `scripts/`.

## Checks

```bash
bun run typecheck
bun run lint
bun test
bun run build
```

CI runs these checks and collects coverage with `bun run test:coverage`. Run a focused test with `bun test tests/<name>.test.ts`. Behavioral, state, data, routing, and contract changes require focused regression coverage.

## Repository map

| Path | Purpose |
| --- | --- |
| `app/` | Next.js routes, API handlers, authentication entry points, and global styles |
| `components/shell/` | App navigation, assistant workspace, shortcuts, and theme providers |
| `components/albatross/` | Areas, Work detail, guided steps, and related controls |
| `components/report/` | Daily Brief rendering and its interactive document canvas |
| `components/` | Mail, calendar, tasks, files, shared controls, and assistant renderers |
| `lib/tools/` | Typed tool definitions, registration, validation, and invocation |
| `lib/ai/`, `lib/albatross/`, `lib/narrative/`, `lib/brief/` | Assistant orchestration, work planning, context, and briefing logic |
| `lib/nylas/`, `lib/mail/`, `lib/calendar/`, `lib/documents/`, `lib/mcp/` | Provider integrations and domain services |
| `convex/` | Persistent data, queries, mutations, scheduled jobs, and generated bindings |
| `lib/mobile/v1/`, `docs/mobile/openapi/` | Native API contract and generated OpenAPI documents |
| `apps/ios/` | Native iOS and macOS apps and the MobileAPI package |
| `tests/`, `scripts/` | Regression coverage, previews, generators, and verification tooling |
| `public/vendor/` | Pinned browser assets with their licenses and notices |

Mail reads use the per-user Convex corpus; Nylas provides connected-account transport. The assistant and UI share tools exposed through `GET /api/tools` and `POST /api/tools/[name]`. The assistant stream lives at `/api/agent`. Tool-specific approval, authorization, and undo rules live alongside the tool implementations.

Tool registrations in [`lib/tools/index.ts`](lib/tools/index.ts), model defaults in [`lib/ai/client.ts`](lib/ai/client.ts), and the version in [`package.json`](package.json) are the sources of truth.

## Releases and operations

For a local production build:

```bash
bun run build
bun run start
```

GitHub Actions deploys `staging` to Railway's `development` environment and `main` to `production`, deploying Convex before the web service. Railway uses `bun run start:railway`, which binds to `0.0.0.0` and the supplied `PORT`. Production CI manages version bumps; see the workflows in [`.github/workflows/`](.github/workflows/).

- [Hosted setup, releases, rollback, and recovery](docs/hosted-release-runbook.md)
- [Google Drive and AI Office operations](docs/google-drive-office-runbook.md)
- [Embedded document editor setup and verification](docs/deployment/documents.md)
- [Granola MCP integration](docs/granola-mcp-integration.md)
- [Native app setup](apps/ios/README.md)
- [Xcode Cloud and TestFlight](docs/mobile/xcode-cloud-testflight.md)

Historical web plans, research notes, and handoffs are available in Git history. Current operational docs, native-client documentation, and license/attribution files remain in the repository.

## Contributing

Follow [`AGENTS.md`](AGENTS.md) and [`CLAUDE.md`](CLAUDE.md) for ownership and testing requirements. Codex owns the web Albatross UI; Claude owns the native Apple clients and mobile v1 contract. Preserve the web design system and density, and include Mobbin plus browser research in PRs that materially change a web surface.

The favicon uses the MIT-licensed Iconify Feather `fe:mail` icon by Megumi Hano. Artwork and vendored assets retain their attribution and license files under `public/`.
