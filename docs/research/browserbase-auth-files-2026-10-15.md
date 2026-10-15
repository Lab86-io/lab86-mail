# Browserbase sign-in, files, and one web layer for Albatross

Date: 2026-10-15. Type: research and small live tests. This document adds no code to the app.
Code read: the worktree `~/repos/lab86-official-docs` (v0.16.35).
Docs read: docs.browserbase.com and the Browserbase changelog, on 2026-10-15.

## 1. Verdicts

1. **Sign-in.** Browserbase does not sign in for a user. It gives Contexts (kept cookies and site
   storage), Live View (a person signs in), and keep alive. Albatross uses this pattern at this time.
2. **Top risk.** `logSession` is `true` by default. A live test shows that a value from Playwright
   `fill()` goes into the session logs. Albatross types passwords and ID numbers from the secure store with `fill()`.
   The fix is `browserSettings.logSession: false`. It works on all plans.
3. **Public files.** Fetch with `format: "raw"` gives a PDF as base64 text. For the W-9, it gave all
   140,815 bytes with no change in 1.3 s. At this time, `browserbase_fetch` sets markdown and gets a 400.
4. **Files in a session.** A download in a session goes to Browserbase storage. The Downloads API
   gives the bytes. The session must call `Browser.setDownloadBehavior` with
   `downloadPath: "downloads"` first. Without it, no file is kept.
5. **Signed-in files.** Use a click (or a page open) and the Downloads API in the user's session.
   An in-page `fetch()` also works for a file on the same site.
6. **`context.request.get()` is not a Browserbase path.** It sends the request from our server.
   It copies the browser cookies to our server. Do not use it.
7. **`secure_fetch` can move into Browserbase**, and the model does not see the key. The
   Fetch API cannot do it (no header field). Functions with Secrets do not fit (one project, not
   one user). A session with a route-added header works. A cold call takes about 2.4 s, about 2 s more than now.
8. **Nominatim moves** to Fetch `raw`. The answer is JSON text.
9. **There is a third path that does not use Browserbase.** `fetchWebFile` (in `tasks_attach_file` and in mail attachments
   from a URL) downloads web files to our server with no Browserbase step. It must move to the new file pull.
10. **Plan.** The project has a concurrency of 25. This is the Developer plan ($20 a month).

## 2. Web paths in the code today

| Path | Module | Browserbase? | Note |
| - | - | - | - |
| Web search | `lib/tools/web.ts` `browserbase_search` | Yes, `POST /v1/search` | The description says "snippets". The API gives no snippet field (section 3.3). |
| Page read | `lib/tools/web.ts` `browserbase_fetch` | Yes, `POST /v1/fetch`, `format: "markdown"` | A PDF gives HTTP 400, so the tool throws. Markdown is "Fetch Extract" ($4 for 1,000). |
| Shared browser, step runner | `lib/albatross/browser-session.ts`, `browser-agent.ts`, `browser-contexts.ts` | Yes, sessions over CDP | `recordSession: false`. `logSession` is not set, so it is `true`. No download behavior is set. |
| Slide render | `lib/documents/deck-render.ts` | Yes, its own REST call | A third copy of the Browserbase client code. |
| Place lookup | `lib/albatross/place-enrichment.ts` | Yes, through `web.ts` | No change necessary. |
| API call with a saved key | `lib/secure/fetch.ts` `secure_fetch` | No. Our server calls the API. | Section 5.7. |
| Reverse geocode | `lib/albatross/intent-plan.ts` `reverseGeocode` | No. Our server calls Nominatim. | Section 5.8. |
| File from a URL | `lib/attachments/fetch-store.ts` `fetchWebFile` | No. Our server downloads the file. | Used by `tasks_attach_file` and by `resolveSendAttachments` in `lib/tools/compose.ts`. Max 25 MB. |
| Sender logos | `app/api/logos/[domain]/route.ts` | No | UI image proxy, not an agent path. Out of scope. |
| Deck assets | `lib/documents/deck-assets.ts` | No | Owned storage only. Out of scope. |

## 3. Capability tables

Plan column: "Dev" is the Developer plan, our plan (section 4.1). The prices come from
[Plans](https://docs.browserbase.com/account/billing/plans) if a row does not give a different source.

### 3.1 Sign-in, identity, and access

| Feature | What it does | API shape | Our plan and cost | Doc |
| - | - | - | - | - |
| Contexts | Keep the Chromium user data: cookies, localStorage, IndexedDB, session storage, service workers, autofill, site settings. Not the HTTP cache. Each Context has its own encryption at rest. A Context has no expiry. But a site can end a sign-in. | `POST /v1/contexts {projectId?, name?}` gives `{id, publicKey, cipherAlgorithm: "AES-256-CBC", initializationVectorSize}`. `GET` and `DELETE /v1/contexts/{id}`. In a session: `browserSettings.context: {id, persist}`. | All plans. No charge. | [Contexts](https://docs.browserbase.com/platform/browser/core-features/contexts) |
| Context names | A unique name for each Context (max 128 characters). The dashboard lists Contexts and their sessions. New in Aug 2026. | `name` on create | All plans | [Changelog](https://www.browserbase.com/changelog/contexts-in-dashboard) |
| Live View | A live, interactive view of one tab. Embed it in an iframe. For read-only, add CSS `pointer-events: none`. One URL for each tab. `&navbar=false` removes the bar. The iframe posts `browserbase-disconnected` when the session ends. `expiresIn` sets the URL life. | `GET /v1/sessions/{id}/debug?expiresIn=60..21600` gives `{debuggerFullscreenUrl, debuggerUrl, wsUrl, pages[]}` | All plans | [Live view](https://docs.browserbase.com/platform/browser/observability/session-live-view), [API](https://docs.browserbase.com/reference/api/session-live-urls) |
| Sign-in guide | Create a Context. Open a session with `persist: true`. The person signs in through Live View. End the session. Wait some seconds. Use the same Context again. | As above | All plans | [Website authentication](https://docs.browserbase.com/platform/identity/authentication) |
| MFA and 2FA | No automatic solution. The guide says: give Live View to the person, or use an app password. | None | None | Same page |
| Passkeys | A CDP virtual authenticator stops passkey prompts. Then the site shows a password form. | `WebAuthn.enable`, `WebAuthn.addVirtualAuthenticator` | All plans | Same page |
| Keep alive | The session stays open when the CDP client disconnects. Release it, or it runs to its timeout. | `keepAlive: true`. Release: `POST /v1/sessions/{id} {status: "REQUEST_RELEASE"}` | Paid plans. Dev has it. | [Keep alive](https://docs.browserbase.com/platform/browser/long-sessions/keep-alive) |
| Timeout | 60 to 21,600 s for each session. Our project default is 300 s. | `timeout` | Dev: max 6 h | [Timeout](https://docs.browserbase.com/platform/browser/long-sessions/timeouts) |
| Regions | `us-west-2` (default), `us-east-1`, `eu-central-1`, `ap-southeast-1`. | `region` | All plans | [Regions](https://docs.browserbase.com/optimizations/latency/multi-region) |
| Proxies | Managed residential proxies with country, state, and city. External proxies. Rules for each domain (`domainPattern`). `type: "none"` for some domains. | `proxies: true` or an array of `{type: "browserbase" \| "external" \| "none", ...}` | Dev: 1 GB in the plan, then $12 for each GB | [Proxies](https://docs.browserbase.com/platform/identity/proxies) |
| Verified | A special Chromium with real fingerprints that bot-protection partners know. `advancedStealth` is deprecated. `os` applies only to Verified. | `browserSettings.verified: true`, `os` | Dev: "Basic". Full Verified only on Scale. | [Verified](https://docs.browserbase.com/platform/identity/verified-customization) |
| CAPTCHA solving | On by default. It uses 5 to 30 s. Console events `browserbase-solving-started` and `browserbase-solving-finished`. Custom selectors for odd CAPTCHAs. | `solveCaptchas`, `captchaImageSelector`, `captchaInputSelector` | Dev: automatic | [CAPTCHA](https://docs.browserbase.com/platform/identity/captcha-solving) |
| Web Bot Auth | Signs requests (RFC 9421 headers `Signature-Agent`, `Signature-Input`, `Signature`). A site can then identify the agent. It does not sign in to an account. | Enabled by request | Beta, by request | [Web Bot Auth](https://docs.browserbase.com/platform/identity/web-bot-auth) |
| Allowed domains | Blocks main-frame navigation to a domain that is not on the list. It does not block frames or page requests. Experimental. | `browserSettings.allowedDomains: ["irs.gov"]` | All plans | [Allowed domains](https://docs.browserbase.com/platform/browser/security/allowed-domains) |
| Logs and video off | `logSession: false` keeps no CDP logs. `recordSession: false` keeps no video. The setting is permanent for that session. | `browserSettings.logSession`, `browserSettings.recordSession` | All plans. Account-wide ZDR is Enterprise only. | [ZDR](https://docs.browserbase.com/account/enterprise/zero-data-retention) |
| Secrets | Values sealed with the project public key. Only Functions that you attach can read them, from `context.secrets`. Not per user. Get and list give metadata only. | `GET /v1/secrets/keypair`, `POST /v1/secrets {name, sealedSecretValue, keypairId}`, attach to a Function | All plans | [Secrets](https://docs.browserbase.com/platform/secrets/overview) |
| 1Password | A recipe, not a feature. Your code reads a vault item with a 1Password service account, then types it. The sample puts the password in a Stagehand prompt, so a model sees it. | 1Password SDK | 1Password cost | [1Password](https://docs.browserbase.com/integrations/1password/quickstart) |
| Evervault Browser Tokens | The page gets tokens. The Evervault proxy changes a token to the clear value only for hosts on a policy. Browserbase and the agent do not see the value. | Session `proxies` from Evervault, plus its CA in `proxySettings.caCertificates` | Evervault cost | [Evervault](https://docs.browserbase.com/integrations/evervault/introduction) |
| Cookie sync | A developer skill. It copies cookies from a local Chrome into a Context. | CLI skill | Not a product path | [Cookie sync](https://docs.browserbase.com/integrations/skills/cookie-sync) |
| Agents pause and variables | A Browserbase agent stops and tells your app that it must have a code (`pauseWhen`). `%name%` variables go into fields, and the value is not in the transcript. | `POST /v1/agents/runs {task, pauseWhen, variables, browserSettings: {context, proxies, verified}}`, `POST /v1/agents/runs/{id}/resume` | Dev: 15 runs a month | [Pausing](https://docs.browserbase.com/platform/agents/pausing-runs) |

### 3.2 Files

| Feature | What it does | API shape | Our plan and cost | Doc |
| - | - | - | - | - |
| Downloads API | Each download in a session is one object. List with filters, get metadata or bytes, delete. Browserbase adds a time suffix in storage, but the API gives the name from the site. Large files can show late. New in May 2026. | `GET /v1/downloads?sessionId=&filename=&mimeType=&minSize=&maxSize=&createdAfter=&createdBefore=&limit=1..100&offset=` gives `{downloads[], total, limit, offset}`. Item: `{id, sessionId, filename, mimeType, size, checksum (SHA-256), createdAt}`. `GET /v1/downloads/{id}` with `Accept: application/json` or `application/octet-stream`. `DELETE /v1/downloads/{id}` gives 204. | All plans. The docs give no download retention. Probably the plan data retention (Dev: 7 days). | [Downloads](https://docs.browserbase.com/platform/browser/files/downloads) |
| Session zip (first version) | All downloads of a session in one zip. It continues to work. | `GET /v1/sessions/{id}/downloads` gives `application/zip` | All plans | [Changelog](https://www.browserbase.com/changelog/improved-downloads-api) |
| Download setup | With Playwright or Puppeteer, set the download behavior first. Use the value `downloadPath: "downloads"` with no change. Playwright sets its own path when it connects, so without this call no file is kept. | CDP `Browser.setDownloadBehavior {behavior: "allow", downloadPath: "downloads", eventsEnabled: true}` | All plans | Same page |
| PDF in a session | Opening a PDF URL starts a download and stops the navigation. `enablePdfViewer: true` shows the PDF in the tab. | `browserSettings.enablePdfViewer` (in the PDF guide, not in the OpenAPI schema) | All plans | [PDFs](https://docs.browserbase.com/platform/browser/files/pdfs) |
| Uploads | Puts a file into the session at `/tmp/.uploads/<name>`. Then CDP `DOM.setFileInputFiles` sets it on an input. Small files can use Playwright `setInputFiles`. For Live View uploads, catch `filechooser` and upload for the user. | `POST /v1/sessions/{id}/uploads` (multipart, field `file`) | All plans | [Uploads](https://docs.browserbase.com/platform/browser/files/uploads) |
| Fetch, binary | A binary body comes back as base64 with `encoding: "base64"`. Max body 5 MB (502 above it). Max 60 s (504). No JavaScript. No PDF to markdown. | `POST /v1/fetch {url, allowRedirects, allowInsecureSsl, proxies, format: "raw"}` gives `{id, statusCode, headers, content, contentType, encoding}` | Dev: 1,000 calls a month, then $1 for each 1,000. With proxies: $4 for each 1,000. | [Fetch](https://docs.browserbase.com/platform/fetch/overview) |
| Page PDF and screenshots | Playwright `page.pdf()` and screenshots go back to your code. Browserbase keeps no copy. | Playwright | Browser time | [Files](https://docs.browserbase.com/platform/browser/files/overview) |

### 3.3 Research, agents, and limits

| Feature | What it does | API shape | Our plan and cost | Doc |
| - | - | - | - | - |
| Search | Web results: `id`, `url`, `title`, and sometimes `author`, `publishedDate`, `image`, `favicon`. No snippet and no page text. Providers: `parallel` (modes `fast`, `advanced`, the default) and `exa`. Parallel is new on 2026-10-14. | `POST /v1/search {query (1..200 characters), numResults (1..25, default 10), provider?, mode?}` gives `{requestId, query, results[]}` | Dev: 1,000 a month. Plans page: then $7 for each 1,000. Search page: parallel fast $1, parallel advanced $5, exa $7, for each 1,000. Rate: 2 a second (plans page) or 120 a minute (search page). | [Search](https://docs.browserbase.com/platform/search/overview) |
| Fetch Extract | Fetch with `format: "markdown"`, or `"json"` with a `schema`. The project must have it turned on (if not, 403). Our project has it. | `format`, `schema` | $4 for each 1,000. With proxies: $7 for each 1,000. Rate: 5 a second. | [Fetch](https://docs.browserbase.com/platform/fetch/overview) |
| Fetch headers | The overview says "custom headers". The OpenAPI schema and SDK 2.14.1 have no `headers`, `cookies`, `method`, or `context` field. Thus the answer is "no". | None | None | [Fetch API](https://docs.browserbase.com/reference/api/fetch-a-page) |
| Sessions | Browser time is billed by the minute. Each session costs a minimum of one minute. | `POST /v1/sessions` | Dev: 100 h a month, then $0.12 for each hour ($0.002 a minute). 25 sessions at one time. 25 new sessions a minute. Retention 7 days. | [Plans](https://docs.browserbase.com/account/billing/plans) |
| Functions | Your TypeScript runs next to a browser. Each run is async and gets a new session. `us-west-2` only. 60 to 900 s. No keep alive. Params max 64 KB. Webhooks for results. | `POST /v1/functions/{id}/invoke {params, sessionCreateParams}`, `GET /v1/functions/invocations/{id}` | Hosted Functions are free. Browser time is billed. | [Functions](https://docs.browserbase.com/platform/functions/overview) |
| Agents | Browserbase operates the full agent loop (Stagehand, search, files, shell). Gives a result and messages. Pause and resume. Not in ZDR. | `POST /v1/agents/runs` | Dev: 15 runs a month | [Agents](https://docs.browserbase.com/platform/agents/overview) |
| Model Gateway, Stagehand v4 | Stagehand calls models through the Browserbase key. Stagehand v4 runs as an extension in the browser (Aug 2026). | Stagehand SDK | Tokens at provider price | [Model Gateway](https://docs.browserbase.com/platform/model-gateway/overview) |
| MCP server | Stagehand tools over MCP, hosted by Browserbase since Mar 2026. | Streamable HTTP | Browser time | [MCP](https://docs.browserbase.com/integrations/mcp/introduction) |
| OpenAI CUA, Director | CUA: a sample app with Browserbase as the computer. Director: a no-code agent product (Director 2.0, Oct 2025). | Not in our stack | None | [CUA](https://docs.browserbase.com/integrations/openai-cua/introduction) |

### 3.4 Changes in 2025 and 2026 that matter here

| Date | Change |
| - | - |
| 2026-10-14 | Search gets the `parallel` provider and `provider`/`mode` fields. Parallel advanced is the new default. |
| 2026-09-30 | Secrets for Functions. |
| 2026-09-24 | Agents `pauseWhen` and resume. |
| 2026-08-19 | Context names and a Contexts page in the dashboard. |
| 2026-08-17 | BYOS can send CDP logs to your S3 (Enterprise). |
| 2026-08-10 | Stagehand v4 (runs as a browser extension). |
| 2026-07-15 | MP4 download of session video. |
| 2026-06-30 | Browserbase Agents. |
| 2026-05-21 | Fetch gives markdown and JSON. Max body goes from 1 MB to 5 MB. |
| 2026-05-06 | New Downloads API: one object for each file. The session zip continues to work. |
| 2026-05-05 | Verified mode in Stagehand. |
| 2026-03-17 | Browserbase Search. |
| 2026-03-11 | Fetch API. |
| 2026-02-10 | Functions. |
| 2026-01-15 | New session video from a CDP screencast. |
| No date in the changelog | `allowedDomains`, `logSession`, `verified` (in place of `advancedStealth`), and `expiresIn` on live URLs are in the API reference at this time. |

## 4. Live test results

All tests used the operator key in `~/.config/lab86-private/browserbase.env`. The scripts read the
key from that file and printed no key, connect URL, or live view URL. The scripts are in
`/tmp/bb-probe/`, not in the repo. The tests used no user Context and changed no Context.

### 4.1 Plan

A `GET /v1/projects` call shows one project, "Production project", with concurrency 25 and a
default timeout of 300 s. Concurrency 25 is the Developer plan. A `GET /v1/projects/{id}/usage`
call shows 862 browser minutes and 4.8 MB of proxy data for this period.

### 4.2 Fetch on the W-9 PDF

Two `POST /v1/fetch` calls went to `https://www.irs.gov/pub/irs-pdf/fw9.pdf` with
`allowRedirects: true`.

| Format | HTTP | Time | Result |
| - | - | - | - |
| `raw` | 200 | 1.26 s | `statusCode` 200, `contentType` `application/pdf`, `encoding` `base64`. `content` is 187,756 base64 characters. Decoded: 140,815 bytes, `%PDF-1.7`, SHA-256 `2d420cbb...093f53`. |
| `markdown` | 400 | 0.67 s | "The fetched URL did not return content that could be converted to the requested format. Use `format: "raw"` if conversion is not required." |

Thus Fetch `raw` is a full file pull for a public file up to 5 MB. Today `browserbase_fetch` uses
`markdown`, so a PDF link gives the model an error.

### 4.3 One session: downloads, request paths, and logs

The test opened one session (no Context, `keepAlive: false`, `timeout: 360`,
`recordSession: false`, logs on). It connected with playwright-core 1.62.1 in node, not in Bun.
It released the session at the end. The session ran for 22 s and ended as `COMPLETED`.

| Step | Time | Result |
| - | - | - |
| Create session | 0.56 s | `RUNNING`, `us-west-2`. Fields: `connectUrl`, `seleniumRemoteUrl`, `signingKey`, `expiresAt`, and others. |
| Get live URLs | 0.21 s | `debuggerFullscreenUrl`, `debuggerUrl`, `wsUrl`, `pages[]`. |
| Connect over CDP | 1.14 s | One context and one page. |
| `page.goto(fw9.pdf)` with no download setup (as the step runner does at this time) | 0.33 s | Error `page.goto: Download is starting`. After 4 s, the Downloads API lists 0 files. |
| Set `Browser.setDownloadBehavior {allow, "downloads"}`, then `page.goto(fw9.pdf)` | 0.16 s | A `download` event for `fw9.pdf`. The tab stays on `about:blank`. |
| Open the IRS "About Form W-9" page, click the `fw9.pdf` link | 0.66 s + 1.97 s | A `download` event. The tab stays on the IRS page. |
| `GET /v1/downloads?sessionId=` | 2.4 s of polls | 2 files, `application/pdf`, 140,815 bytes each. `checksum` equals the SHA-256 of the Fetch bytes. |
| `GET /v1/downloads/{id}` (metadata, then bytes) | 1.17 s | `application/pdf`, `Content-Disposition: attachment; filename="fw9.pdf"`, the same 140,815 bytes. |
| `context.request.get(fw9.pdf)` | 0.74 s | The same bytes. But the request left from the IP of the test computer, not from the Browserbase browser IP. A cookie that the remote browser held went with the request. |
| In-page `fetch(fw9.pdf, {credentials: "include"})` from the IRS page | 0.59 s | The same bytes. The request left from the Browserbase browser. |
| `GET /v1/sessions/{id}/downloads` after release | not timed | `application/zip`, 240,470 bytes (the two PDFs). |
| `DELETE /v1/downloads/{id}` for the two files | not timed | 204 and 204. |

### 4.4 Session logs keep values

The test typed a test value into a page field with `fill()`. It sent a test header from an
in-page `fetch()`. It opened a URL with a test cookie value. Then it read
`GET /v1/sessions/{id}/logs`.

- Right after the release, the logs had 127 entries and no test value. Some minutes after that, they
  had 367 entries and all three test values. The logs come late.
- The typed value is in `Input.insertText` and `Runtime.callFunctionOn` (raw CDP command body).
- The header value is in `Runtime.callFunctionOn` (the arguments of the evaluate call).
- The cookie value is in `Page.navigate` (the URL).
- Network events keep only the method and the URL. They keep no request headers.

Result: a value that our server sends into the browser through CDP is kept in the session logs.
Browserbase keeps it for the plan data retention (Dev: 7 days). The observability page says up to
30 days for session data. The step runner types saved passwords
and ID numbers with `fill()`. `docs/albatross-secure-store.md` says that no log holds a value.
The session settings in `lib/albatross/browser-session.ts` break that rule at this time. The test did not
test Live View typing, but Live View input probably goes through CDP `Input.*` too.

## 5. Recommended design: one Browserbase layer

### 5.1 Rules

1. Albatross gets to the web only through Browserbase: Search, Fetch, or a session.
2. Our server makes no HTTP request to a web host that the model or a user chose.
3. Each session sets `logSession: false` and `recordSession: false`.
4. The model gets text, file metadata, and handoffs. It does not get bytes, cookies, keys, or URLs
   that hold a token.
5. A file goes from Browserbase to our server through the Browserbase REST API, not through CDP.
6. One REST client holds the Browserbase key. Nothing else reads the key.

### 5.2 Modules and owners

| Module | Owns | Replaces |
| - | - | - |
| `lib/web/browserbase-client.ts` (new) | The key, the project id, time limits, the error class, retry on 429. Calls: search, fetch, sessions (create, release, live URLs), contexts, downloads (list, get, delete), uploads. | `postBrowserbase` in `lib/tools/web.ts`, `browserbaseRequest` in `browser-session.ts`, the REST calls in `deck-render.ts`. |
| `lib/web/read.ts` (new) | `searchWeb` and `readPage`. `readPage` sets markdown. On a 400 for a PDF, it sets `raw` and gets the text with `pdfjs-dist` (a dependency at this time). | The handlers in `lib/tools/web.ts`. |
| `lib/web/file-pull.ts` (new) | `pullWebFile(url, options)`: tier 1 Fetch `raw`, tier 2 a short download session, tier 3 a download in the user's session. Checks the type from the first bytes, the size, and the SHA-256. | `fetchWebFile` in `lib/attachments/fetch-store.ts`. |
| `lib/albatross/browser-session.ts` | Session settings: `logSession: false`, `expiresIn` on live URLs, optional `allowedDomains` and `proxies`. | Its own REST helper. |
| `lib/albatross/browser-agent.ts` | Sets the download behavior when it connects. Catches each `download` event and records its name and time. Does not use `context.request`. | None |
| `lib/web/session-fetch.ts` (new, phase 2) | `secure_fetch` through a session (section 5.7). | The server-side call in `lib/secure/fetch.ts`. |

### 5.3 Tools

| Tool | Surface | Browserbase call | What the model gets |
| - | - | - | - |
| `browserbase_search` | Chat, runner, planner | `POST /v1/search` | Title, URL, date. Fix the description: no snippets. |
| `browserbase_fetch` | Chat, runner, planner | `POST /v1/fetch` markdown, then `raw` and PDF text for a PDF | Page text (cut), the content type, the final URL. |
| `web_file_save` (new) | Chat, runner | `pullWebFile` tier 1, then tier 2 | `{fileId, name, size, type, sourceHost}` |
| `browser_download` (new) | Runner, in the shared session | Click a ref or open a URL, then the Downloads API | `{fileId, name, size, type}`. A new file also shows in the run log. |
| `tasks_attach_file` and mail attachments with `url` | Chat | `pullWebFile` | No change in the tool contract. |
| `secure_fetch` | Runner | Phase 1: server-side call (no change). Phase 2: `session-fetch.ts` | No change in the tool contract. |

### 5.4 How secrets stay out of the model and out of logs

| Secret | Where it goes | Control |
| - | - | - |
| Browserbase key | Server only. The connect URL holds it, so the connect URL stays on the server (correct at this time). | One client module. |
| A saved password or ID (`{{secure:...}}`) | The server opens it at use time and types it with `fill()`. It goes to Browserbase through CDP. | `logSession: false` (new). Page text is cleaned before the model reads it (correct at this time). |
| A site sign-in | The user types it in Live View. The Context keeps the cookies, with encryption at rest. | `logSession: false`. A short `expiresIn` on the live URL. |
| Cookies | They stay in the Browserbase browser and in the Context. | No `context.request`. No `context.cookies()` call to our server. |
| A file | Browserbase storage, then our server through the Downloads API, then Files. | Delete the Browserbase copy after the copy to Files. The model gets metadata only. |
| An API key (phase 2) | The server adds the header in a route handler. It goes to Browserbase through CDP. | `logSession: false`, a session with no Context, `allowedDomains` set to the API host. |

### 5.5 A signed-in download

Example: a pay statement on a payroll site where the user signed in before.

1. The runner opens the shared session with the user's Context (the writer lease is unchanged).
2. On connect, `browser-agent.ts` sets `Browser.setDownloadBehavior` with `"downloads"`.
3. The model opens the documents page. If the site shows a sign-in form, the run hands off with
   `next.kind: "sign_in"`. The user signs in through Live View. The run continues.
4. The model calls `browser_download({ ref })` on the "Download PDF" control. The final-action
   guard continues to apply, but a download control is not a final action.
5. The server clicks and waits for the `download` event. It keeps the click time.
6. The server calls `GET /v1/downloads?sessionId=<id>&createdAfter=<click time>`. It polls at 2 s intervals
   for a maximum of 20 s.
7. The server gets the bytes with `GET /v1/downloads/{id}`. It checks the first bytes, the size
   (max 25 MB), and the `checksum`.
8. The server puts the file in Files with its source host, time, and SHA-256.
9. The server calls `DELETE /v1/downloads/{id}`.
10. The model gets `{fileId, name, size, type}`. The run log says "Saved pay-2026-09.pdf from
    adp.com."

For a link to a file on the same site, an in-page `fetch(url, {credentials: "include"})` also
works (0.59 s in the test). But the bytes come back through CDP. Use the click path first.

### 5.6 The W-9, end to end

1. The plan has a step: "Get the current Form W-9."
2. The model calls `browserbase_search({ query: "IRS Form W-9 PDF" })`. It gets the irs.gov URL.
3. The model calls `web_file_save({ url: "https://www.irs.gov/pub/irs-pdf/fw9.pdf", name: "Form W-9.pdf" })`.
4. The server checks that the URL is https. It calls Fetch with `format: "raw"` and
   `allowRedirects: true`.
5. The answer is 200, `application/pdf`, base64. The server decodes 140,815 bytes and checks
   `%PDF-`. Time: about 1.3 s.
6. The server puts the file in Files with the source `irs.gov` and its SHA-256.
7. The model gets `{fileId, name, size: 140815, type: "application/pdf", sourceHost: "irs.gov"}`.
8. If the model must read the form text, `browserbase_fetch` gets the PDF text through the
   `raw` path and `pdfjs-dist`.
9. The package handoff shows the file next to the draft and the invoice. After that, a
   `pdf_form_fill` tool can fill it (a different design).

Tier 2 (Fetch gives 403, 502 for size, or an HTML sign-in page): the server opens a short session
with no Context, sets the download behavior, opens the URL, and uses steps 6 to 9 of section 5.5.
The test proved this path for the W-9: same bytes, about 5.4 s in total (create 0.6 s, connect
1.1 s, download 0.2 s, list 2.4 s, get 1.2 s).

### 5.7 `secure_fetch`

**Verdict: it can move, and the model does not see the key.**

- The Fetch API cannot do it. It has no header, cookie, or method field.
- Functions with Secrets do not fit. A Secret belongs to the project and to one Function. It is
  not for one user. A Function run is async, has a time limit of 60 to 900 s, and is only in `us-west-2`.
- A session can do it. The server does the reference checks of today (https, a host saved for
  the key). Then it does these steps:
  1. Open a session with no Context, `logSession: false`, `recordSession: false`,
     `allowedDomains: [host]`, and `timeout: 60`.
  2. Add a `page.route` handler for that one URL. The handler continues the request with the
     header and with the method (`GET` or `HEAD`).
  3. Open the URL as a top-level page. A top-level request has no CORS check.
  4. If the response is a redirect, stop, as today.
  5. Read the body, remove the saved values, cut it to 20 KB, and release the session.
- Time (from the test): create 0.56 s, connect 1.14 s, request 0.6 to 0.7 s. A cold call takes
  about 2.4 s, about 2 s more than a server-side call. In a session that is open before the call,
  the call takes about 0.6 s. A cold session costs a minimum of one browser minute ($0.002).
- Trust: the key goes through Browserbase. Passwords from the secure store go through Browserbase at this time when the
  runner types them, so the trust boundary does not get larger. With `logSession: false`,
  Browserbase keeps no copy.
- Result: our server then sends no request to a host that a user chose. The SSRF check
  (`assertPublicHttpUrl`) is no longer necessary for this path.

Recommendation: phase 1 changes no `secure_fetch` code. Phase 2 adds `session-fetch.ts` behind a
flag, with the server-side path as the fallback. Remove the server-side path after the route method is satisfactory in
tests (the live test did not try the `page.route` header method).

### 5.8 Nominatim

Move `reverseGeocode` to Fetch `raw` with the same URL. The content is JSON text, so parse
`content`. The time limit of 10 s and the `null` fallback stay. Risk: the Nominatim rules tell users to send an
application User-Agent, and Fetch sends a browser User-Agent. If Nominatim blocks the call, the
function gives `null`, and the plan works without the city. The coordinates then also go to
Browserbase.

### 5.9 Order of work

1. Set `logSession: false` in `createBrowserSession` and in `deck-render.ts`. This fix is
   necessary at this time, and it does not wait for the other parts of this design.
2. Make `lib/web/browserbase-client.ts`, and move the three copies of the client into it.
3. Add the PDF path to `browserbase_fetch`. Fix the search description.
4. Add `pullWebFile` and `web_file_save`. Move `fetchWebFile` callers to it.
5. Set the download behavior in `browser-agent.ts`. Add `browser_download`.
6. Move Nominatim to Fetch.
7. Phase 2: `session-fetch.ts` for `secure_fetch`.

Each step must have tests. A thread contract change (a file item in a handoff) must go to web, iOS,
and macOS together.

## 6. Risks and open questions

### Risks

- **Logs hold values from the secure store at this time.** Section 4.4. Production sessions since the secure store release
  can hold typed passwords and IDs in Browserbase logs for 7 to 30 days. The fix in section 5.9 step 1
  stops new copies. Copies from before the fix expire with the retention. The CASA data flow text must say this.
- **Live View typing.** A user who signs in through Live View probably sends keys through CDP.
  With logs on, Browserbase can keep them. The same fix applies.
- **Live URL life.** `debuggerFullscreenUrl` gives full control of the browser to each person who has it. At this time,
  it lives as long as the session (1 h). Set `expiresIn` (for example 900 s) and get a new URL
  when necessary.
- **One Context for all sites.** Browserbase says "one Context for each site and each sign-in",
  and "no sessions at the same time on one Context". Albatross uses one Context for each user, and
  a reader session can run next to the writer. A large Context makes sessions slow, and a site can
  end a sign-in when it sees two sessions.
- **PDF pages in the runner.** Today `browser_open` on a PDF URL stops with "Download is
  starting", and no file is kept. Step 5 of section 5.9 corrects this.
- **Fetch limits.** 5 MB, 60 s, no JavaScript. A file above 5 MB must use tier 2. The 5 MB limit can
  apply to the source body or to the base64 text. The docs do not say.
- **Search content.** Search gives no snippet. A model that thinks it has snippets can make claims with
  no source text. Read pages with Fetch before a claim.
- **Cost.** `browserbase_fetch` uses Fetch Extract ($4 for each 1,000). `raw` costs $1 for each
  1,000. A PDF read through `raw` is cheaper than markdown.
- **Downloads retention.** Browserbase probably keeps each download for the plan retention (7 days).
  Delete it after the copy.

### Open questions

1. Does the production Railway key belong to the same Browserbase organization and project? The
   operator key shows one project, "Production project". Compare the project ids without a print
   of a key.
2. Does `page.route` with `route.continue({ headers })` work over `connectOverCDP` to Browserbase?
   Test it one time before phase 2.
3. Does Live View input show in the session logs? A test with a test password in a test session
   gives the answer.
4. Does a download from a popup tab, or from a `blob:` link, show in the Downloads API? The
   Agents docs say yes for agents. Test one site.
5. Is the 1,000 Fetch calls a month for `raw` only, or for Extract too?
6. Must chat get a session tool, or only `web_file_save` and the reads? Today chat has search and
   fetch only.
7. Is Verified ("Basic" on Developer) sufficient for the sites of the dogfood work? If not, the
   options are proxies, Scale, or a person in Live View.
8. Is a Browserbase Agent run (with `pauseWhen` and `variables`) a better runner for some steps
   than our loop? It gives no control of the model or the cost, and it is not in ZDR.

## 7. Sources

- Browserbase docs index: https://docs.browserbase.com/llms.txt
- Plans: https://docs.browserbase.com/account/billing/plans
- Create a session (OpenAPI): https://docs.browserbase.com/reference/api/create-a-session
- Contexts: https://docs.browserbase.com/platform/browser/core-features/contexts
- Website authentication: https://docs.browserbase.com/platform/identity/authentication
- Live view: https://docs.browserbase.com/platform/browser/observability/session-live-view
- Downloads: https://docs.browserbase.com/platform/browser/files/downloads
- PDFs: https://docs.browserbase.com/platform/browser/files/pdfs
- Uploads: https://docs.browserbase.com/platform/browser/files/uploads
- Fetch: https://docs.browserbase.com/platform/fetch/overview
- Search: https://docs.browserbase.com/platform/search/overview
- Observability and session logs: https://docs.browserbase.com/platform/browser/observability/observability
- Zero data retention: https://docs.browserbase.com/account/enterprise/zero-data-retention
- Functions limits: https://docs.browserbase.com/platform/functions/limits
- Secrets: https://docs.browserbase.com/platform/secrets/overview
- Agents: https://docs.browserbase.com/platform/agents/overview
- Changelog: https://www.browserbase.com/changelog
