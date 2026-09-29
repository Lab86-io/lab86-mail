# Google user data: data flow

Product: Albatross, from Lab86. Hosts: `mail.lab86.io` (production) on Railway.
Database and file storage: Convex. Status of this text: 2026-09-28, branch
`claude/casa-verify`.

This document tells where Google user data goes, step by step. Each step names
the code. The mark "(after the casa-prep round)" identifies a statement that is
correct only when the named work of that round is merged and deployed.

## Diagram

```
                          +------------------+
   User (web, iOS, Mac) --|  Clerk sign-in   |  identity only, no Google data
                          +------------------+
           |
           | TLS
           v
 +-------------------------+    OAuth code + PKCE     +-----------------------+
 |  Albatross web server   |<------------------------>|  Google OAuth         |
 |  (Next.js on Railway)   |                          +-----------------------+
 |                         |    Gmail / Calendar /    +-----------------------+
 |  - API routes           |<------------------------>|  Google APIs          |
 |  - model gateway        |    People / Drive APIs   |  (direct, after the   |
 |  - AES-256-GCM secrets  |                          |   casa-prep round)    |
 +-------------------------+                          +-----------------------+
   |        |         |    \                          +-----------------------+
   |        |         |     `------------------------>|  Nylas (today: Google |
   |        |         |       mail, calendar,         |  mail and calendar;   |
   |        |         |       contacts                |  after the round:     |
   |        |         |                               |  Microsoft and iCloud)|
   |        |         |                               +-----------------------+
   |        |         v
   |        |   +-------------------+   model calls   +-----------------------+
   |        |   | OpenRouter        |---------------->| OpenAI, Anthropic,    |
   |        |   | (text, embeddings)|                 | other chosen models   |
   |        |   +-------------------+                 +-----------------------+
   |        v
   |   +-------------------------+
   |   | Convex (database, file  |  encrypted at rest (AES-256, Convex platform)
   |   | storage, vector index)  |
   |   +-------------------------+
   v
 +---------------------------------------------------------------+
 | Notifications: Apple APNs (sender, subject), web push (fixed  |
 | text), Resend e-mail (opt-in brief; fixed check-in text)      |
 +---------------------------------------------------------------+
 +---------------------------------------------------------------+
 | Browserbase: web search, guided-work browser, slide render    |
 | (no mail is sent there directly; see step 8)                  |
 +---------------------------------------------------------------+
```

## 1. Sign-in to Albatross

- Clerk hosts sign-in and sign-up (`app/sign-in/[[...sign-in]]/page.tsx:24`,
  `app/sign-up/[[...sign-up]]/page.tsx:37`). The proxy makes a Clerk session necessary
  on each route that is not public (`proxy.ts:12-59`).
- The sign-in and sign-up pages name Albatross, tell what it does, and link
  the privacy policy and the terms (`components/auth/AuthScreen.tsx`). A
  signed-out visit to `/` goes to `/sign-in`.
- Albatross reads only the Clerk profile: user id, e-mail address, name, and
  image (`lib/auth/current-user.ts:21-68`). Albatross never reads Google data
  through Clerk. The code has no `getUserOauthAccessToken` call.

## 2. Connect a Google account (OAuth)

- **Mailbox (today).** `GET /api/nylas/connect` makes a single-use state (10
  minutes) and sends the user to Nylas hosted OAuth
  (`app/api/nylas/connect/route.ts:80-108`). The Google consent screen shows
  Albatross. The callback exchanges the code with Nylas and keeps the grant id,
  the address, the scopes, and the encrypted tokens
  (`app/api/nylas/callback/route.ts:51-74`). Nylas keeps the Google tokens.
- **Mailbox (after the casa-prep round).** A Google account uses a direct
  Google OAuth flow with PKCE (`docs/google-direct-transport.md`). Albatross
  keeps the Google refresh token encrypted in `providerGrants.refreshTokenEncrypted`.
  The web callback accepts only a session whose user id equals the user id of
  the state (item: "OAuth callbacks bound to the signed-in user").
- **Google Drive.** `GET /api/files/oauth/start` makes a state (10 minutes)
  and a PKCE verifier (`lib/files/connections.ts:93-108`). The callback checks
  that the signed-in user owns the state
  (`app/api/files/oauth/callback/route.ts:74-77`). The tokens are encrypted
  before Convex keeps them (`lib/files/connections.ts:252-255`).
- **Encryption of secrets.** `encryptSecret` uses AES-256-GCM with a random
  12-byte IV (`lib/security/crypto.ts:17-28`). The key comes from the
  environment variable `LAB86_MAIL_ENCRYPTION_KEY`. Each ciphertext carries a
  key id (after the casa-prep round, item: "key ids on encrypted secrets").

## 3. Sync

- **Today (Nylas).**
  - Nylas sends webhooks for message, event, contact, and grant changes
    (`scripts/nylas-provision.ts:37-50`). The route checks the HMAC-SHA256
    signature (`app/api/nylas/webhook/route.ts:57-79`).
  - A webhook row in Convex keeps ids only, not mail content
    (`lib/mail/webhook-storage.ts:1-4`, `:67-80`).
  - Schedules in `convex/crons.ts`: calendar at 15-minute intervals (`:39`),
    contacts at 1-hour intervals (`:43`), mail repair at 30-minute intervals (`:149`).
- **After the casa-prep round (direct Google).** A schedule reads the Gmail
  History API at 2-minute intervals for each direct account. A Pub/Sub push route
  is in the code but stays off until the owner makes a subscription
  (`docs/google-direct-transport.md`, section "Sync").

## 4. Storage in Convex

Convex keeps all data. Convex encrypts all customer data at rest with 256-bit
AES, and all data in transit with TLS (<https://www.convex.dev/security>).
Albatross also encrypts tokens and keys before it writes them (step 2). Mail
content has no second, app-level encryption.

| Data | Table | Code |
|---|---|---|
| Thread: subject, sender, snippet, labels, category | `mailCorpusThreads` | `convex/schema.ts:290-382` |
| Message: subject, from, to, cc, bcc, snippet, labels, attachment metadata, some headers | `mailCorpusMessages` | `convex/schema.ts:405-452`; mapping `lib/mail/corpus-sync.ts:917-965` |
| Body: text up to 32,000 characters, HTML up to 200,000 characters | `mailCorpusBodies` | `convex/schema.ts:457-472`; caps `lib/mail/corpus-body.ts:22-26` |
| Calendar: calendars and events (−92 to +366 days, history 5 years) | `calendars`, `calendarEvents` | `convex/schema.ts:1715-1789`; window `lib/calendar/sync.ts:16-22` |
| Contacts: names, addresses, phones, company, title, photo URL | `contacts`, `contactEmails` | `convex/schema.ts:1850-1889` |
| Recipient counts from mail | `correspondents` | `convex/schema.ts:1898-1917` |
| Search index text and vectors | `contentItems`, `contentChunks` | `convex/contentSchema.ts:9-46` |
| Daily Brief editions, chat history | `userDocs` | `lib/store/daily-reports.ts`, `lib/store/chat-sessions.ts` |
| Tokens (encrypted) | `providerGrants`, `cloudFileCredentials` | `convex/schema.ts:175-190` |

**Attachments.**

- Today, Albatross does not keep attachment files. The attachment route
  streams the file from the provider with `cache-control: private, no-store`
  (`app/api/attachments/[messageId]/[attachmentId]/route.ts:43-66`, `:86-103`).
- The index reads the text of an attachment (8 MiB maximum) and keeps only the
  extracted text (`lib/content/mail-attachments.ts:30-78`,
  `lib/content/extract.ts:6-22`).
- After the casa-prep round (item: "attachment files stored in Convex file
  storage"), Albatross keeps attachment files in Convex file storage. A file is
  25 MB or less. Albatross deletes it after 60 days, or at disconnect.

**Vectors.**

- The index makes one text item for each mail thread of the last 60 days
  (`lib/content/sync.ts:42`). The text holds the sender, the subject, and the
  body of the newest 16 messages (`convex/content.ts:422-454`).
- The index also has attachment text and Drive file text
  (`lib/content/cloud-sync.ts:160-225`).
- The text goes in chunks of 4,000 characters to OpenRouter for embeddings
  with `openai/text-embedding-3-small`, 1,536 dimensions
  (`lib/content/intelligence.ts:100-116`, `lib/content/contract.ts:5-7`).
- Convex keeps the vectors in `contentChunks` (`convex/contentSchema.ts:38-46`).

## 5. Model calls

- **Gateway.** All model calls go through `lib/ai/gateway.ts` and
  `lib/ai/client.ts`. The OpenRouter base URL is `https://openrouter.ai/api/v1`
  (`lib/ai/client.ts:10`).
- **Production keys (checked 2026-09-28).** Production has an OpenRouter key.
  It has no direct OpenAI key and no direct Anthropic key. Thus the platform
  sends all model calls through OpenRouter. A user can add an own key for
  OpenRouter, OpenAI, or Anthropic. Albatross encrypts that key
  (`app/api/ai/settings/route.ts:320`) and then sends that user's calls to that
  provider (`lib/ai/gateway.ts:347-377`).
- **Models.** The code has defaults. Production overrides some of them with
  environment variables. On 2026-09-28 we read only the vendor part of each
  production value.

  | Use | Code default | Production on 2026-09-28 | Code |
  |---|---|---|---|
  | Main tier | `openai/gpt-5.5` | An Anthropic model (`LAB86_MAIL_OPENAI_MODEL`) | `lib/ai/gateway.ts:149-169` |
  | Fast tier | `openai/gpt-5-nano` | An Anthropic model (`LAB86_MAIL_OPENAI_FAST_MODEL`) | same |
  | Bulk tier | `openai/gpt-5-nano` | An Anthropic model (`LAB86_MAIL_OPENAI_NANO_MODEL`) | same |
  | Classification tier | `openai/gpt-5.6-luna` | Code default | same |
  | Fallback for the assistant and the brief | `anthropic/claude-sonnet-4.6`, `anthropic/claude-haiku-4.5`, `openai/gpt-5.5`, `openai/gpt-5.4-mini` | Anthropic models (`LAB86_MAIL_AGENT_FALLBACK_MODEL`) | `lib/ai/gateway.ts:89-94` |
  | Mail classifier (Jev) | `typesafe/jev-1.13` on the OpenRouter `decisions` endpoint | Code default | `lib/classifier/catalog.ts:48-60` |
  | Embeddings | `openai/text-embedding-3-small` | Code default | `lib/content/contract.ts:6` |
  | Shared narrative (on in production) | `z-ai/glm-5.3-flash` | Code default | `convex/narrative.ts:225`, `lib/narrative/service.ts:32-42` |

  Thus, in production, the providers behind OpenRouter are Anthropic, OpenAI,
  TypeSafe (Jev), and Z.ai, plus the model that a user picks.

  A user can pick other catalog models for the main and fast tiers. The
  catalog has models from OpenAI, Anthropic, Google, xAI, DeepSeek, Z.ai,
  Moonshot, Qwen, and Meta (`lib/ai/model-catalog.ts:146-454`).
- **Features that send Google data to a model.** Each feature is a user-facing
  feature. Examples with code:
  - mail classification and search order (`lib/jev/service.ts:77-84`,
    `lib/jev/search.ts:40-71`);
  - Area routing (`lib/albatross/area-classifier.ts:282-296`);
  - the Daily Brief (`lib/mail/daily-report.ts:1030-1038`,
    `lib/mail/brief-prose.ts:498-503`);
  - the assistant chat and its tools (`lib/ai/loop.ts:915-941`);
  - summaries, draft replies, and translation (`lib/tools/ai.ts`);
  - urgent-mail checks and event suggestions
    (`lib/mail/urgent-detectors.ts:58-74`, `lib/mail/suggestion-detectors.ts:90-101`);
  - the writing-voice profile from sent mail (`lib/mail/voice-profile.ts:170-184`).
- **No training.** Every OpenRouter call sets `provider.data_collection` to
  `deny` (`lib/ai/openrouter-policy.ts`; after the casa-prep round, item:
  "OpenRouter `data_collection: deny` on all model calls"). With this setting,
  OpenRouter does not send the call to a provider that can train on the data
  or store it for a long time. The setting is not zero data retention (ZDR). A
  provider can keep a request for a short time, for example for abuse checks:
  OpenAI and Anthropic keep requests for up to 30 days. The code does not set
  the OpenRouter `zdr` field.
- **Cost records.** Albatross keeps a usage record for each model call: user
  id, feature, model, tokens, and cost (`convex/schema.ts:273-288`). The record
  has no mail content. Failed calls also get a cost record (after the casa-prep
  round, item: "failed-call cost records").

## 6. Notifications

| Channel | What leaves Albatross | Code |
|---|---|---|
| Apple APNs (iOS, macOS) | New mail: title is the sender, body is the subject (or the snippet). Urgent mail: sender, subject, and a short reason. Digest: count and up to two sender names. Brief ready: the first 180 characters of the brief lede. Ids of account, thread, and message. | `lib/notifications/apns.ts:131-151`; `convex/albatrossNotifications.ts:736-737`, `:798-801`; `lib/notifications/mail-push.ts:127-138`; `lib/mail/brief-ready.ts:23-34` |
| Web push | Check-in prompts with fixed text only. No mail content. | `lib/notifications/delivery.ts:138-156`; `convex/albatrossNotifications.ts:150-162` |
| E-mail through Resend | Brief by e-mail, off by default: thread subjects, senders, short reasons, the lede, and event titles, times, and places. Check-in fallback: fixed text. | `lib/mail/brief-email.ts:199-233`; default off `convex/dailyReports.ts:414`; `lib/notifications/delivery.ts:171-199` |

Apple receives the APNs payload only to deliver it to the user's device. The
user controls notifications in Settings and in the device settings.

## 7. Logs and monitoring

- The server writes logs to Railway standard output. Albatross has no
  third-party error tracker and no analytics service (no Sentry, PostHog,
  Datadog, or similar package in `package.json`).
- The audit line writes the user id and the tool name. It removes the
  arguments (`lib/store/audit.ts:3-19`).
- No log line writes a subject, a body, or a token intentionally. Some catch
  blocks log a raw model error object (for example
  `lib/mail/daily-report.ts:1068`). A model SDK error can hold the text that
  the call sent. This is an open item for the security workstream.

## 8. Browserbase

Albatross code never sends a mail body, an address list, or calendar data to
Browserbase directly. Three features use Browserbase:

1. **Web search and web fetch for the assistant** (`lib/tools/web.ts:45-79`).
   The model writes the search words or the URL. The words can come from the
   user's question or from mail that the model read.
2. **The guided-work browser.** It opens the URL of a work step in a
   Browserbase session that Browserbase records
   (`lib/albatross/browser-session.ts:84-94`). Albatross reads up to 6,000
   characters of page text back (`lib/albatross/browser-session.ts:185-202`).
3. **Slide render.** Albatross renders a deck in a Browserbase browser when
   Browserbase is set up (`lib/documents/deck-render.ts:137-178`). A deck can
   hold text from mail if the user made the deck from mail.

## 9. Other services that receive user data

| Service | What it receives | Code |
|---|---|---|
| Nylas | Today: all Google mail, calendar, and contact traffic. After the casa-prep round: Microsoft and iCloud accounts only; a switched Google account keeps its old Nylas grant until disconnect or until the owner-run cleanup (`scripts/nylas-grant-cleanup.ts`). | `lib/nylas/client.ts:62`; `docs/google-direct-transport.md` |
| Clerk | Identity. The brief e-mail reads the primary address from Clerk. | `lib/auth/current-user.ts`; `lib/mail/brief-email.ts:168-176` |
| Railway | Hosts the web server and its logs. | `railway.json` |
| DuckDuckGo and Google favicon services | The registrable domain of a company sender or a web site, for the logo. Personal mail domains are excluded. The browser sends some requests, so the service also gets the user IP address. | `lib/tools/photo-resolution.ts:188-226`; `lib/mail/sender-logo.ts:127-141`; `app/api/logos/[domain]/route.ts` |
| Open-Meteo | The device location that the user shares, or up to 3 place names from calendar events, or the city of the time zone, for the brief weather. | `lib/mail/brief-weather.ts:100-195`; `lib/weather/open-meteo.ts:214-260` |
| OpenStreetMap Nominatim | The device location (latitude and longitude) for a search of places near the user in a plan. It returns the city and region. | `lib/albatross/intent-plan.ts:929-946` |
| Google Maps (browser) | The place text of a calendar event, when the user opens the event details. | `components/calendar/engine/event-details-dialog.tsx:230` |
| Browser push services (Google, Mozilla, Apple) | Encrypted web push messages with fixed text. | `lib/notifications/delivery.ts:94-100` |
| Connected tools (GitHub, Bitbucket, Jira, Slack, Granola) | The requests of the user, when the user connects the tool. | `lib/mcp/servers.ts` |
| Hosts that the browser loads directly | The user IP address: Google Fonts (brief pages), public museum collections (brief art), DiceBear (a generated picture with the author name of a social post). | `lib/mail/report-artifact.ts:35`; `lib/mail/daily-art.ts`; `lib/tools/display.ts:556` |
| Collabora Online | Office documents that the user opens. Lab86 hosts it on Railway. | `docs/deployment/documents.md` |
| Stripe (through Clerk Billing) | Billing only. No Google data. | `app/api/billing/webhook/route.ts:6-13` |

## 10. Backups

- The repository has no backup job and no export job. A manual Convex export
  step is in the release runbook (`docs/hosted-release-runbook.md:389-403`).
- Convex keeps platform backups under its own policy. The owner makes sure of the
  Convex plan and its backup retention (see `submission-checklist.md`).

## 11. Deletion

See `retention-and-deletion.md`. In short:

- Disconnect deletes the mail, calendar, and contact data of the mailbox in
  Convex and destroys the Nylas grant. Some derived rows stay until account
  deletion (see the open items in `retention-and-deletion.md`).
  After the casa-prep round, disconnect also deletes the index rows and the
  attachment files of that mailbox.
- Account deletion deletes all Convex data of the user and the Clerk user.
- A mailbox that stays in an error state for 30 days loses its mail data
  (`convex/deadAccounts.ts:16-17`).

## Limited Use

- Albatross uses Google user data only to give the features that the user sees
  in the product.
- Albatross does not sell Google user data and does not use it for ads.
- Albatross sends Google user data to a third party only to give a feature:
  the model providers through OpenRouter, Nylas, Convex, Railway, Apple push,
  Resend, Browserbase, and the other services in section 9, as listed above.
- Albatross does not use Google user data to train general models. The
  OpenRouter setting `data_collection: deny` (after the casa-prep round) keeps
  calls away from providers that train on data.
- Lab86 staff do not read user mail, except with the user's consent, for
  security, or when the law makes it necessary (`app/privacy/page.tsx:67-92`).
