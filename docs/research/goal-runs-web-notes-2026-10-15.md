# Goal runs: the web layer (G5), build notes

Date: 2026-10-15. Branch: `claude/goal-runs-web`.
Design: `docs/albatross-goal-runs.md` (G5, decision D2).
Research: `docs/research/browserbase-auth-files-2026-10-15.md`.

## 1. What the branch adds

| Module | What it does |
| - | - |
| `lib/web/browserbase-client.ts` | The one Browserbase REST client. It is the only reader of the key. It has Search, Fetch, sessions, live URLs, release, contexts, and the Downloads API. Every session has `recordSession: false` and `logSession: false`. It tries a 429 again two times. |
| `lib/web/read.ts` | `searchWeb`, `readPage`, and `readJson`. `readPage` asks for markdown. On a 400 it asks for the raw bytes and gets the text: PDF with `pdfjs-dist`, Office files from their XML, and text files as text. Max 80,000 characters. |
| `lib/web/session.ts` | Short sessions (`withShortSession`), the Playwright connector, the download behavior, the in-page `fetch()`, and the Downloads API collector. A short session reads saved sign-ins and never saves them. |
| `lib/web/file-pull.ts` | `pullWebFile`, `saveWebFile`, and `saveBrowserDownload`. Tier 1 is Fetch raw. Tier 2 is a session with no saved sign-ins. Tier 3 is a session with the user's saved sign-ins, read only. |
| `lib/web/research.ts` | `runWebResearch`: searches and page reads in parallel, then numbered sources with short passages. |
| `lib/web/session-fetch.ts` | `secure_fetch` in a session, behind `LAB86_SECURE_FETCH_BROWSERBASE` (off by default). |
| `tests/web-egress.test.ts` | The egress scan of `lib/` and `app/`. |

These modules now use the client: `lib/tools/web.ts`, `lib/albatross/browser-session.ts`,
`lib/albatross/browser-agent.ts`, `lib/documents/deck-render.ts`, `lib/attachments/fetch-store.ts`,
`lib/albatross/intent-plan.ts`, and `lib/secure/fetch.ts`.

## 2. Tool shapes

| Tool | Input | Result |
| - | - | - |
| `browserbase_search` | `{ query, limit }` | `{ results: [{ title, url, publishedDate?, author? }] }`. No snippets. |
| `browserbase_fetch` | `{ url }` | `{ url, content, contentType, status?, truncated? }` |
| `web_research` | `{ question, queries (1 to 6), sites? (max 6) }` | `{ ok: true, sources: [{ n, title, url, passage, signedIn? }], failed: string[] }` |
| `web_file_save` | `{ url, name? }` | `{ ok: true, fileId, title, openPath, size, contentType, sourceUrl?, sha256 }` |
| `browser_download` (runner) | `{ ref?, url?, name? }` | The same shape as `web_file_save`. |

- `web_research` and `web_file_save` are registry tools in the new chat group `web`. The runner
  list belongs to the core builder.
- `browser_download` records a `file` artifact and one log line itself.
- `web_research` limits: 6 searches, plus 1 search for each of the first 2 sites; 6 pages
  read; max 3 pages in a browser; max 2 sessions; 20 s for each page; 60 s in total;
  700 characters for each passage.

## 3. Live tests

Each test used the operator key. No test used a user Context. Each session was released. Each
test download was deleted. Logs were off. No output held a key or a connect URL.

| Test | Result |
| - | - |
| `searchWeb("IRS Form W-9 PDF")` | 5 results. The first two are irs.gov. The rows have no snippet. |
| `readPage` on the IRS "About Form W-9" page | Markdown, 22,548 characters, 0.6 s. |
| `readPage` on `fw9.pdf` | Markdown gave 400. Raw and pdfjs gave 38,475 characters of text in 2.0 s. |
| Tier 1 pull of `fw9.pdf` | 140,815 bytes, SHA-256 `2d420cbb...093f53` (the same as the research), 0.6 s. |
| Nominatim through Fetch raw | 200, `application/json`. The city came back. 0.8 s. |
| Tier 2 pull (the test made Fetch give 502) | The same 140,815 bytes and SHA-256 through the Downloads API, 7.0 s. |
| `browser_open` on `fw9.pdf` in the runner browser | "This address is a file, not a page. Save it with browser_download and url." |
| `browser_download` by ref (the "Form W-9 PDF" link) | 140,815 bytes, `sourceUrl` `https://www.irs.gov/pub/irs-pdf/fw9.pdf`. 0 files left in storage. |
| `browser_download` by url | 140,815 bytes. |
| `secure_fetch` session path, a dummy header to httpbin.org/headers | The echo shows the header. 200 in 2.6 s to 4.2 s (new session). |
| The same path with Playwright `route.continue` and a 302 | **The dummy header went to the next redirect hop.** The code does not use this method now. |
| The same path through the CDP Fetch domain, a 302 | 302 came back. The redirect was not followed. |
| HEAD, and a 401 | 200 with no body, and 401. |
| `web_research` (W-9 revision, site irs.gov) | 4 irs.gov sources with passages in 5.6 s. |

## 4. What still reaches the web outside Browserbase

The egress test lists each one. A new one fails the test.

| Path | Why it stays |
| - | - |
| `secure_fetch` with the flag off (the default) | The session path is new. Turn it on after one check in production. The server path accepts only https, a public host that the user saved the key for, and no redirect. |
| One-click unsubscribe (`lib/mail/unsubscribe.ts`) | The user starts it. RFC 8058 needs a POST with a body; the Fetch API has no method or body field. It accepts https and a public host only, with no redirect. |
| Sender logos (`app/api/logos/[domain]`) | A UI image proxy with fixed logo services. The sender's domain goes in the path. |
| Deck art (`lib/documents/deck-art.ts`) | Fixed museum APIs and image hosts, behind `DECK_ART_LIVE`. The image fetch follows redirects; a later change must correct this. |
| Weather (`lib/weather/open-meteo.ts`) | A fixed weather API for the Brief. |
| First-party APIs | Google, Nylas, Convex, OpenRouter and the model providers, Atlassian, Slack, GitHub, Bitbucket, Microsoft Graph, Clerk, Resend, Apple (WeatherKit, APNs over HTTP/2), the document server. |

## 5. Changes from the design and the task

1. The module name is `lib/web/browserbase-client.ts` (as in the research), not `lib/web/browserbase.ts`.
2. The `secure_fetch` session path uses the CDP Fetch domain, not `page.route`. Reason: the live
   test in section 3.
3. `fetchWebFile` (task attachments and mail attachments from a URL) now accepts only the seven
   file types. Before, it accepted any type. A `.txt`, `.zip`, or `.gif` from a URL now fails.
4. `browserbase_fetch` now cuts the text at 80,000 characters. Before, it had no limit.
5. `web_file_save` uses the user's saved sign-ins only after Fetch fails or gives a page. It
   never uses them for a public file.
6. The session release now deletes the files that the session left in Browserbase storage.
7. `deck-render.ts` keeps `renderSessionBody(projectId)` from PR #332, with the same values.
8. `secure_fetch` through a new session takes about 3 to 4 s, not 2.4 s as in the research.

## 6. Open questions

1. Must the runner list (core) also get `web_research` and `web_file_save` before the release?
2. Does a download from a popup tab show in the Downloads API? `browser_download` waits on the
   current tab only.
3. Is a `.txt` or `.zip` from a URL necessary for mail attachments? If yes, add a small "attach
   only" type list.
4. Must `tool-shapes.ts` (ui-web) get shapes for `web_research` (sources) and `web_file_save` (a file)?
5. When can `LAB86_SECURE_FETCH_BROWSERBASE` go on in production?
