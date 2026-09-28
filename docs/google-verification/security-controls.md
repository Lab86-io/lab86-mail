# Security controls: CASA self-assessment answers

Product: Albatross, from Lab86. Assessment lab: TAC Security (Premium plan).
Status of this text: 2026-09-28, branch `claude/casa-verify`.

## Standard and process

- The current standard is the CASA Specification v2.1.1 of the App Defense
  Alliance (ADA), dated 2026-06-03. It has 48 requirements. Each requirement
  maps to an OWASP ASVS 4.0.3 item.
  Source: <https://github.com/appdefensealliance/ASA-WG/blob/main/CASA/CASA%20Specification.md>.
- Google now sets an assurance level, AL1 or AL2, not a "tier"
  (<https://support.google.com/cloud/answer/13465431>). All 48 requirements
  apply at both levels. The levels differ only in who tests.
- For the Google OAuth program, the lab runs the DAST scan. A developer
  self-scan does not replace it (ADA AL1 questionnaire, row F1).
- The old "Tier 2" self-scan (134 ASVS items) is deprecated. ADA keeps it only
  as a readiness check (<https://appdefensealliance.dev/casa/tier-2/tier2-overview>).
- Clerk is in scope only for authentication, session management, and access
  control ("Specification Scoping Guidance" in the CASA specification).

Answer key: **Yes** = the control is in place, with evidence. **Partial** = in
place with a gap. **No** = not in place. "(after the casa-prep round)" marks a
control that the named work of that round adds. "Owner confirms" marks a
setting that is in a vendor dashboard, not in the code.

## 1. Authentication

| ID | Requirement | Answer | Evidence |
|---|---|---|---|
| 1.1.1 | Authentication resists brute force | Yes (owner confirms) | Clerk hosts sign-in (`app/sign-in/[[...sign-in]]/page.tsx:36`). Clerk gives bot protection and account lockout; the owner confirms both in the Clerk dashboard. App routes have per-user rate limits in 85 route files (`lib/rate-limit.ts:23-38`, `convex/rateLimits.ts`). |
| 1.1.2 | Initial passwords and activation codes are random and expire | Yes | Albatross issues no passwords. Clerk sends the e-mail codes. |
| 1.1.3 | Passwords resist offline attacks | Yes | Clerk keeps and hashes passwords. Albatross has no password field (`convex/schema.ts`) and no password hash code. |
| 1.2.1 | No default credentials | Yes | No built-in accounts. The Convex internal secret comes from the environment. `requireInternalSecret` fails closed when the secret is not set (`convex/lib.ts:1-8`). |
| 1.3.1 | Out-of-band verifier expires | Yes | Clerk codes (Clerk). App tokens: OAuth state 10 minutes (`lib/files/connections.ts:102`, `app/api/nylas/connect/route.ts:92`); Files completion token 5 minutes (`lib/files/connections.ts:141`); native sign-in ticket 60 seconds (`app/api/native/web-session/route.ts:65-68`). |
| 1.3.2 | Out-of-band verifier is used once | Yes | OAuth states and the Files completion token are deleted when used (`convex/cloudFiles.ts` `consumeOAuthState`, `consumeOAuthCompletion`). Clerk sign-in tickets are single-use. |
| 1.3.3 | Out-of-band verifier is random | Yes | `randomBytes(24)` or `randomBytes(32)` from `node:crypto` (`app/api/nylas/connect/route.ts:34`, `lib/files/connections.ts:93-94`, `:134`). |
| 1.3.4 | Out-of-band verifier resists brute force | Yes | 192 to 256 random bits, short life, single use. The OAuth start routes have rate limits. |

## 2. Session management

| ID | Requirement | Answer | Evidence |
|---|---|---|---|
| 2.1.1 | No session tokens or API keys in URLs | Partial | Clerk sends the session in a cookie or in the `Authorization` header (`proxy.ts:127-133`). Exception: the Office document server gets a short-lived, document-bound capability token in the query string (`lib/documents/office-service.ts:154-159`); it expires with the editor session (`:131`). |
| 2.2.1 | Logout; logout ends the session | Yes | "Sign out" calls `clerk.signOut` (`app/settings/page.tsx:1551`). Clerk ends the session and its client token. |
| 2.2.2 | End other sessions after a password change | Yes (owner confirms) | Clerk handles password changes. Settings opens the Clerk profile, with the list of signed-in devices (`app/settings/page.tsx:1534-1541`). |
| 2.2.3 | Stateless tokens expire in 24 hours or less | Yes | The Clerk session JWT lives 60 seconds and refreshes in the background (<https://clerk.com/docs/guides/how-clerk-works/overview>). App tokens: native browser cookie 1 hour (`lib/native/browser-access.ts:3-4`); one-time-code consume token 30 minutes (`lib/mail/one-time-code-token.ts:12`); notification links 7 days, single purpose (`lib/notifications/delivery.ts:46`). |
| 2.3.1 | Session cookies have `Secure` | Yes | Clerk sets its cookies on HTTPS. HSTS is on (`next.config.ts:31`). |
| 2.3.2 | Session cookies have `HttpOnly` | Partial | The long-lived Clerk client token (`__client`) is `HttpOnly` and `SameSite=Lax` on the Clerk domain. The 60-second `__session` JWT on the app domain is readable by script by Clerk design (Clerk link above). |
| 2.3.3 | Session tokens, not static API secrets | Yes | Users use Clerk sessions. The iOS app sends the Clerk session JWT as a Bearer token (`apps/ios/Lab86Mail/Core/API/BackendClient.swift:189`). The static internal secret is only for server-to-server calls. |
| 2.3.4 | Stateless tokens are signed | Yes | Clerk JWTs are signed. App tokens use HMAC-SHA256 and `timingSafeEqual` (`lib/mail/one-time-code-token.ts:46-65`, `lib/documents/office-security.ts:116-128`, `lib/native/browser-access.ts:15-47`). |
| 2.4.1 | Full session or re-authentication before sensitive changes | Partial | Account deletion, disconnect, and sends need a full Clerk session and have rate limits (`app/api/account/route.ts:12-18`). Albatross does not ask for a second check before account deletion. Password and MFA changes happen in Clerk. |

## 3. Access control

| ID | Requirement | Answer | Evidence |
|---|---|---|---|
| 3.1.1 | Least privilege on a trusted service layer | Yes | The proxy requires a Clerk session on all non-public routes (`proxy.ts:12-59`). Each handler gets the user from `requireCurrentUser` (`lib/auth/current-user.ts:71-77`). Store access uses `requireStoreUserId` (`lib/store/kv.ts:19-25`). |
| 3.1.2 | Users cannot change access attributes | Yes | The user id comes from the Clerk session, never from the body. A Convex function honors a `userId` argument only with the internal secret (`convex/lib.ts:1-8`). A scripted check found no public Convex function that reads `args.userId` without that secret. |
| 3.1.3 | Access control fails securely | Yes | `requireCurrentUser` throws `AuthRequiredError` (401). A missing Convex secret throws the same error as a wrong secret (`convex/lib.ts:3-7`). |
| 3.1.4 | IDOR protection | Yes | Each read is scoped by the session user. Example: the attachment route finds the mailbox by the session user (`app/api/attachments/[messageId]/[attachmentId]/route.ts:86-93`, `lib/nylas/provider.ts:1107-1125`). Public board links use a 122-bit random token (`lib/tools/tasks.ts:586`). |
| 3.1.5 | Anti-CSRF | Partial | Clerk session cookies are `SameSite=Lax`, and state changes use POST, PATCH, or DELETE with JSON. The OAuth start routes change state on GET. The lab DAST gives the final answer. |
| 3.1.6 | No directory browse | Yes | Next.js serves no directory lists. ZAP found none (section 8). |
| 3.2.1 | Only safe OAuth flows | Yes | Authorization code flow with PKCE for Drive (`lib/files/providers.ts:88-113`) and for direct Google mail (after the casa-prep round). The Nylas flow is an authorization code flow with the client secret on the server (`app/api/nylas/callback/route.ts:51-56`). No implicit or password flow. |
| 3.2.2 | `redirect_uri` and `state` are validated | Partial | `state` is random, single-use, and short-lived. Files checks the state owner against the session (`app/api/files/oauth/callback/route.ts:74-77`). Mailbox and tool callbacks check it too (after the casa-prep round, item: "OAuth callbacks bound to the signed-in user"). Gap: `sanitizeInternalPath` accepts `/%09/host` (section 9, finding S2). |
| 3.3.1 | MFA on admin interfaces | Partial (owner confirms) | Albatross has no admin console in the app. Operator APIs need the Clerk admin plan (`app/api/jev/settings/route.ts:66`). The admin consoles are Google Cloud, Railway, Convex, Clerk, GitHub, Cloudflare, Apple, OpenRouter, and Nylas. The owner turns on MFA for each (see `submission-checklist.md`). |

## 4. Communications and cryptography

| ID | Requirement | Answer | Evidence |
|---|---|---|---|
| 4.1.1 | TLS 1.2 or later, secure ciphers | Yes | On 2026-09-28, `mail.lab86.io` refused TLS 1.0 and 1.1 and accepted TLS 1.2 (ECDHE-ECDSA-AES256-GCM-SHA384) and TLS 1.3. HSTS `max-age=31536000; includeSubDomains` (`next.config.ts:31`). The lab needs a Qualys SSL Labs report (owner step). |
| 4.1.2 | Trusted certificates | Yes | Railway serves a public CA certificate. Outbound calls use the Node.js default trust store. |
| 4.1.3 | No weak cryptography | Yes | AES-256-GCM with a random 12-byte IV (`lib/security/crypto.ts:17-28`). HMAC-SHA256 for tokens. SHA-256 for fingerprints. `Math.random` has no security use. |
| 4.1.4 | Crypto fails securely, no padding oracle | Yes | GCM has no padding. A bad tag throws, and the caller gets a generic error. Improvement: set `authTagLength: 16` in `createDecipheriv` (section 9, finding S6). |

## 5. Input validation and output encoding

| ID | Requirement | Answer | Evidence |
|---|---|---|---|
| 5.1.1 | HTTP parameter pollution | Yes | Handlers read one value with `searchParams.get`. Bodies are JSON checked by zod in tool and mobile routes (`lib/tools/registry.ts:95-111`, `lib/mobile/v1/http.ts:57-68`). |
| 5.1.2 | Redirects only to allowed URLs | Partial | Internal redirect paths go through `sanitizeInternalPath` (`lib/security/redirect.ts:6-12`). Gap: a tab or newline after the first `/` passes the check (finding S2). |
| 5.1.3 | No `eval` or dynamic code | Yes | A search of `app/`, `lib/`, `convex/`, and `components/` finds no `eval(` or `new Function(` outside generated files. Model-written HTML runs only in sandboxed iframes without `allow-same-origin` (`components/report/DailyReport.tsx:761`, `components/albatross/AreaHome.tsx:1651`). |
| 5.1.4 | Template injection | Yes | React escapes output. No server template engine uses user input. |
| 5.1.5 | SSRF | Partial | Outbound hosts are fixed for logos, weather, MCP, and Office. User URLs go through `assertPublicHttpUrl`, which checks DNS, private ranges, and each redirect (`lib/attachments/fetch-store.ts:78-150`). Gap: IPv4-mapped IPv6 in hex form and DNS rebind (finding S3). |
| 5.1.6 | XPath and XML injection | Yes | No XPath. XML parse (`xml-js`) reads Office files only, with ZIP checks (`lib/documents/office-security.ts:63-113`). |
| 5.1.7 | XSS | Partial | Mail HTML goes through DOMPurify (`lib/sanitize.ts:28-109`) into an iframe without `allow-scripts` (`components/thread/ThreadView.tsx:1163-1170`). Markdown uses Streamdown with its sanitizer. Gaps: no script CSP (nonce-based CSP after the casa-prep round), and the Daily Brief iframe has no CSP of its own (finding S5). |
| 5.1.8 | Database injection | Yes | Convex has no query language. All reads use typed index calls and validators (`v.*`). |
| 5.1.9 | OS command injection | Yes | The one `spawn` call starts a fixed worker script with fixed arguments (`lib/documents/spreadsheet-server.ts:29-36`). User data goes to the worker as JSON over IPC. |
| 5.1.10 | File inclusion | Yes | No dynamic `import` with user input. The deck asset reader resolves a path and refuses a path outside `public/` (`lib/documents/deck-assets.ts:31-37`). The font reader uses fixed names (`lib/documents/deck-render.ts:51`). |
| 5.2.1 | Malicious uploads | Yes | Agent uploads: allowlist of types, 25 MB and 5 files (`lib/ai/chat-attachments.ts:4-40`, `app/api/agent/uploads/route.ts:11-12`). Office files: ZIP checks for macros, encryption, path traversal, and size (`lib/documents/office-security.ts:63-113`). Files go to Convex storage, never to the web root. Downloads send `nosniff` and a sandbox CSP (`app/api/attachments/[messageId]/[attachmentId]/route.ts:43-66`). |

## 6. Configuration

| ID | Requirement | Answer | Evidence |
|---|---|---|---|
| 6.1.1 | No components with known exploitable vulnerabilities | Partial | See section 8. This branch updates `next`, `dompurify`, and `postcss`. Two critical Next.js advisories need `next` 16.3.3 or later. Other high advisories are in transitive packages. |
| 6.2.1 | Debug modes off in production | Yes | `next start` production build; `poweredByHeader: false` (`next.config.ts:55`). Dev pages call `notFound()` in production (`app/dev/*/page.tsx`). ZAP found no debug header. |
| 6.3.1 | Origin header not used for access control | Yes | No handler reads `Origin` for access. The proxy uses `req.nextUrl.origin` only to bind the native browser cookie to its own host (`proxy.ts:62-66`). |
| 6.4.1 | No subdomain takeover | Yes (owner confirms) | The owner confirms that each DNS record of `lab86.io` points to a live service (Railway, Clerk, Resend). |
| 6.5.1 | No credentials in logs | Partial | No log line writes a token or key on purpose. The audit line removes arguments (`lib/store/audit.ts:6-19`). The Nylas webhook logs only the envelope (`app/api/nylas/webhook/route.ts:84-93`). Gap: some catch blocks log raw model errors, which can hold prompt text (finding S8). |
| 6.6.1 | Browser storage cleared at logout | No | Sign-out does not clear `localStorage` (`lab86-mail-ui` holds the selected account and the last search) or `sessionStorage` (`lib/client-state.ts:305-337`) (finding S9). |
| 6.7.1 | Server secrets kept securely | Yes | Secrets are Railway and Convex environment variables. `.gitignore` excludes `.env`, `.env.local`, `.env.*.local`, `*.pem`, and `apps/ios/Config/Local.xcconfig`. Git tracks only `.env.example`, which has no secret values. OAuth tokens and user API keys are AES-256-GCM encrypted in Convex, with key ids (after the casa-prep round). Gitleaks found no secret in the tree or the history (section 8). |

## 7. Other ASVS topics

| Topic | Answer | Evidence |
|---|---|---|
| Error handling | Partial | API routes return no stack traces. Many routes return `err.message` in an error answer: 79 such lines in `app/api` (for example `app/api/tools/[name]/route.ts:60`) (finding S7). |
| Logging and monitoring | Partial | Railway keeps standard output. Security events that are logged: Nylas signature failures (`app/api/nylas/webhook/route.ts:84-93`), audit lines for tool calls and sends (`lib/store/audit.ts`). Not logged: Clerk webhook signature failures, cron 401 answers. No alerting on security events. Cost alarm e-mail exists (`lib/notifications/cost-alarm.ts`). |
| Data protection | Yes | Convex encrypts data at rest with AES-256 (<https://www.convex.dev/security>). Tokens have app-level encryption. Attachments stream with `no-store` today. Retention rules are in `retention-and-deletion.md`. Users can export and delete their data (`app/api/account/export/route.ts`, `app/api/account/route.ts`). |
| Malicious code | Yes | All code is in one private GitHub repository with review by pull request and CodeRabbit (`.coderabbit.yaml`). CI pins GitHub Actions by SHA and sets `persist-credentials: false` (`.github/workflows/ci.yml:18-35`). Semgrep and Fluid Attacks found no back door or time bomb pattern. |
| Business logic | Yes | Actions that send mail, change events, or delete data from the assistant need user approval (`lib/ai/approval.ts:45-60`). Model-written pages ask for confirmation before a state change (`components/report/DailyReport.tsx:529-538`). Per-user rate limits and a model cost alarm limit automated use. |
| Files and resources | Yes | See 5.2.1. The attachment route sends only raster images, PDF, plain text, audio, and video inline. All other types download with a sandbox CSP (`app/api/attachments/[messageId]/[attachmentId]/route.ts:14-66`). |
| API security | Partial | All `/api` routes need a Clerk session except the listed public routes, each with its own check (`proxy.ts:12-41`; test `tests/proxy-public-routes.test.ts`). Webhooks check signatures: Clerk through Svix (`app/api/clerk/webhook/route.ts:23-28`), Nylas through HMAC and `timingSafeEqual` (`app/api/nylas/webhook/route.ts:57-79`). Cron routes check the internal secret in constant time (`lib/cron-auth.ts:6-17`). Gap: `LAB86_MAIL_ALLOW_UNVERIFIED_WEBHOOKS=1` turns off the Nylas check in any environment (`app/api/nylas/webhook/route.ts:63`); production does not set it (checked 2026-09-28). |
| Dependency management | Partial | `bun.lock` pins all versions; CI installs with `--frozen-lockfile`. No automatic dependency scan in CI (no Dependabot, Renovate, or OSV step). Scans of 2026-09-28 are in section 8. |
| Secrets management | Yes | See 6.7.1. The encryption key rotates with key ids (after the casa-prep round, item: "key ids on encrypted secrets"). Gitleaks: no true positive. |

## 8. Scan evidence (2026-09-28)

All scans ran on this branch in `/home/jjalangtry/repos/lab86-casa-verify`.
The DAST scan ran against production.

| Tool | Version | Target | Result |
|---|---|---|---|
| `bun audit` | Bun 1.3.11 | `bun.lock` | Before the bumps: 67 advisories (2 critical, 28 high, 30 moderate, 7 low) in 19 packages. After the bumps: 46 (2 critical, 22 high, 19 moderate, 3 low) in 18 packages. |
| OSV-Scanner (`ghcr.io/google/osv-scanner`) | 2.6.0 | `bun.lock`, iOS `Package.resolved` | `bun.lock` before the bumps: 69 advisory groups in 22 package versions (2 critical, 30 high, 31 moderate, 5 low, 1 not rated). iOS packages: no issues. |
| Semgrep (`semgrep/semgrep`) | 1.177.0 | `app/`, `lib/`, `convex/`, `components/`, `proxy.ts`, `next.config.ts` with `p/owasp-top-ten`, `p/typescript`, `p/react`, `p/nextjs`, `p/secrets` | 1,164 files, 117 rules. 6 findings: 1 error, 5 warnings. |
| Fluid Attacks SAST (`fluidattacks/sast`) | 1.0.0 (image of 2026-09-28) | same folders | 4 findings, all rule F188. Ran without an account. |
| Gitleaks (`zricethezav/gitleaks`) | 8.30.1 | working tree; git history | Tree: 4 findings, all false positives. History: see the report of the integrator. |
| OWASP ZAP baseline (`ghcr.io/zaproxy/zaproxy:stable`) | 2.17.0 | `https://mail.lab86.io/sign-in`, `/pricing`, `/privacy`, `/terms` (passive, no login) | 0 high. 5 medium alert types, 5 low, 5 informational. 0 FAIL, 9 WARN, 58 PASS for each page. |

### ZAP alerts

| Risk | Alert | Verdict |
|---|---|---|
| Medium | CSP: Failure to Define Directive with No Fallback; CSP: Wildcard Directive; CSP: `script-src unsafe-inline`; CSP: `style-src unsafe-inline` (plugin 10055) | True positive. The CSP has only `frame-ancestors` (`next.config.ts:30-35`). The nonce-based CSP closes it (after the casa-prep round). |
| Medium | Sub Resource Integrity Attribute Missing (90003) | Accepted risk. The scripts come from `clerk.mail.lab86.io`, the Clerk frontend API on our own domain. Clerk changes the file with each release, so a fixed hash breaks sign-in. The CSP allowlist limits script hosts. |
| Low | Cross-Domain JavaScript Source File Inclusion (10017) | False positive. The host is `clerk.mail.lab86.io`, our Clerk subdomain. |
| Low | Permissions Policy Header Not Set (10063) | True positive. Add `Permissions-Policy` (camera, microphone, geolocation off). Owner: security. |
| Low | Cross-Origin-Opener-Policy missing (90004) | True positive. Add `Cross-Origin-Opener-Policy: same-origin-allow-popups` (OAuth uses redirects, and some links open new tabs). Owner: security. |
| Low | Cross-Origin-Resource-Policy missing (90004) | True positive, low impact. Add `Cross-Origin-Resource-Policy: same-site`. Owner: security. |
| Low | Cross-Origin-Embedder-Policy missing (90004) | False positive for this app. `require-corp` blocks third-party images in mail. The app does not use `SharedArrayBuffer`. |
| Info | Content-Type Header Missing (10019) | False positive. `/` and `/robots.txt` answer with a 307 redirect to sign-in and have no body. |
| Info | Re-examine Cache-control (10015) | False positive. `/privacy`, `/terms`, and `/support` are public static pages. |
| Info | Modern Web Application; Storable and Non-Storable Content (10109, 10049) | Information only. |

## 9. Findings for the integrator

Each true positive has an owner workstream. S1 to S12 are from the scans and
from the code review for this document.

| # | Finding | Severity | Owner | Fix proposal |
|---|---|---|---|---|
| S1 | `next` 16.2.12 still has GHSA-2xp9-vwfh-vxw4 (RCE in image optimization with AVIF) and GHSA-p293-qw3h-jr36 (Windows only). | Critical (AVIF); not applicable on Linux (Windows) | security | Update to `next` 16.3.6 (minor). The app has no `next/image` use, so also set `images: { unoptimized: true }` after a check that `/_next/image` then stops optimization. |
| S2 | Open redirect after OAuth: `sanitizeInternalPath` accepts `/%09/evil.com` and `/%0A/evil.com`; `new URL` makes `https://evil.com/` (`lib/security/redirect.ts:6-12`; used at `app/api/nylas/callback/route.ts:117`, `app/api/files/oauth/callback/route.ts:32`). | Medium | security | Reject control characters and white space, then compare `new URL(path, base).origin` with the app origin. Add tests for `%09`, `%0A`, and `%0D`. |
| S3 | SSRF guard gap: `http://[::ffff:127.0.0.1]/` becomes `::ffff:7f00:1`, which `isBlockedIpv6` does not match (`lib/attachments/fetch-store.ts:53-67`). DNS is checked, then `fetch` resolves again (DNS rebind window). | Medium | attachments | Normalize IPv4-mapped IPv6 in hex form; block `::ffff:0:0/96`, `64:ff9b::/96`, and `::/96`. Connect to the checked IP (custom `lookup` in an undici `Agent`). Add tests. |
| S4 | `bun audit` high advisories in transitive packages: `ws` (convex, jsdom), `fast-uri` (ajv), `image-size` (pptxgenjs), `ip-address` and `hono` (MCP SDK), `linkify-it` (ansi-to-react), `nanoid` 5 (docx), `brace-expansion` (exceljs), `deepmerge-ts` (html-to-text), `sharp` (next), `uuid` 8 (exceljs). | High (library), reachability not shown | security | Add `overrides` in `package.json` for patch-compatible versions (`ws` 8.21, `fast-uri` 3.1.6, `ip-address` 10.3.1, `nanoid` 5.1.16, `brace-expansion` 1.1.18 and 2.1.4). Run `bun test`. Write a reachability note for each item that stays. |
| S5 | The Daily Brief iframe runs model-written HTML with `allow-scripts` and no CSP (`components/report/DailyReport.tsx:401-417`, `:761`). A prompt-injected brief can send brief text (mail data) to any host with `fetch` or an image URL. The Area brief has a CSP (`lib/albatross/area-living-brief.ts:370`). | Medium | security | Inject the same kind of CSP meta tag as `area-living-brief.ts:370` (`connect-src 'none'`, `img-src data: blob:`, `form-action 'none'`). Check that it works with the nonce-based CSP of the app. |
| S6 | Semgrep `gcm-no-tag-length`: `createDecipheriv('aes-256-gcm', …)` without `authTagLength` (`lib/security/crypto.ts:35`; same in `claude/casa-sec`). A short tag lowers the forgery bound. | Low | security | Pass `{ authTagLength: 16 }` and reject a tag that is not 16 bytes. |
| S7 | Many API routes (79 lines in `app/api`) return `err.message` in error answers (for example `app/api/tools/[name]/route.ts:60`, `app/api/attachments/[messageId]/[attachmentId]/route.ts:105`). | Low | security | Return a generic message and log the detail. |
| S8 | Raw model error objects go to the log (for example `lib/mail/daily-report.ts:1068`). An AI SDK `APICallError` holds `requestBodyValues`, the prompt with mail text. | Medium (Limited Use) | data | Log `name`, `statusCode`, and `message` only. Add a log helper and a test. |
| S9 | Sign-out does not clear browser storage (CASA 6.6.1). | Low | security | On sign-out, remove `lab86-mail-ui` and the other `localStorage` and `sessionStorage` keys, then call `clerk.signOut`. |
| S10 | `LAB86_MAIL_ALLOW_UNVERIFIED_WEBHOOKS=1` turns off the Nylas signature check in any environment (`app/api/nylas/webhook/route.ts:63`). | Low | security | Honor the flag only when `NODE_ENV !== 'production'`. |
| S11 | Staging Basic auth compares with `===` (`proxy.ts:109`). | Low (staging only) | security | Use a constant-time compare. |
| S12 | The chart tool puts model-given series keys and colors into a `<style>` element (`components/ui/chart.tsx:86-104`; schema `components/tool-ui/chart/schema.ts:9-13`). | Low | security | Allow only `[A-Za-z0-9_-]` in keys and a CSS color pattern in colors. |

False positives:

| Tool | Finding | Reason |
|---|---|---|
| Semgrep | `wildcard-postmessage-configuration` at `components/albatross/AreaHome.tsx:1530`, `components/report/DailyReport.tsx:465`, `:471`, `:525`, `lib/theme/brief-theme.ts:62` | The target is a sandboxed `srcdoc` iframe without `allow-same-origin`. Its origin is opaque (`null`), so `'*'` is the only target that works. The window reference is the frame's own `contentWindow`. The messages hold theme values, dismissed ids, and action answers. See S5 for the related CSP gap. |
| Fluid Attacks | F188 "origin of message events is not checked" at `components/albatross/AreaHome.tsx:1616`, `components/report/DailyReport.tsx:733`, `components/report/brief-canvas/BriefCanvasLeaf.tsx:73` | Each listener checks `event.source === frame.contentWindow`. For an opaque-origin frame this check is stronger than an origin check. Each listener also allows only known actions. |
| Fluid Attacks | F188 at `components/files/CollaboraFrame.tsx:187` | The listener checks both `event.origin === session.serverUrl` and `event.source` (`components/files/CollaboraFrame.tsx:140`). |
| Gitleaks | `generic-api-key` at `.env.example:73` | The value is empty. The rule matched across the line break into the next variable name. |
| Gitleaks | `generic-api-key` at `tests/albatross-notification-audit-fixes.test.ts:338` | The line is a list of environment variable names, not values. |
| Gitleaks | `generic-api-key` at `tests/tools-calendar-sync-now.test.ts:209`, `:219` | Test idempotency keys, not secrets. |

Other items from this review, owned by the workstreams of the casa-prep round:

- Mailbox and tool OAuth callbacks do not check the session user
  (`app/api/nylas/callback/route.ts:33-66`, `app/api/mcp/oauth/callback/route.ts:43-76`).
  Item: "OAuth callbacks bound to the signed-in user".
- Mailbox disconnect keeps the index rows. Item: "disconnect deletes the content
  index too".
- No OpenRouter call sets `data_collection: deny`. Item: "OpenRouter
  `data_collection: deny` on all model calls".
