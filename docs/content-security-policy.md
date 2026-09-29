# Content-Security-Policy and response headers

The policy code is in `lib/security/csp.ts`. `proxy.ts` applies it to each page request.

## How it works

1. `proxy.ts` makes a random 128-bit nonce for each page request.
2. It builds the policy with `buildContentSecurityPolicy` and sends it on the response.
3. It also puts the policy and an `x-nonce` header on the request for the page render. Next.js
   reads the nonce from the policy and puts it on its own scripts. The root layout reads `x-nonce`
   and gives it to Clerk and next-themes.
4. The root layout reads the request headers, so every page renders per request. A prerendered
   page has no nonce on its scripts, and the browser would block them.

API routes and `/__clerk` get no page policy. `next.config.ts` gives API responses
`frame-ancestors 'self'`, except the two routes that send a complete policy of their own
(`/api/attachments/...` and `/api/albatross/plan/[planId]/artifact`). Next.js keeps a header that is
already on the response and drops the route's copy, so a static policy on those routes would
replace their sandbox policy.

## Frames that inherit the policy

A `srcdoc` frame inherits the policy of the page, also when the frame is sandboxed. The Daily
Brief, the area brief, and the brief canvas frames need their inline runtime scripts. The host
components put the page nonce on each script of the frame document with `withFrameNonce`
(`lib/security/frame-nonce.ts`) before they set `srcDoc`. The helper also does this for nested
`srcdoc` widget frames. It replaces inline image `onerror` handlers (which a nonce policy never
runs) with one script that has the same fallback behavior. The frames stay sandboxed with an
opaque origin.

The mail reader frame runs no scripts. It needs remote images only, so `img-src` allows any HTTPS
host.

The native apps show briefs in a `WKWebView` with their own policy and nonce bridge
(`DailyBriefView.swift`). That HTML does not come from a page response, so this policy does not
apply to it.

## Rollback switch

`LAB86_CSP_MODE` on the Railway `web` service:

| Value | Effect |
| --- | --- |
| `enforce` | Default in production. Sends `Content-Security-Policy`. |
| `report-only` | Sends `Content-Security-Policy-Report-Only`. The browser reports violations in the console and blocks nothing. |
| `off` | Sends no page policy. |

A change needs a redeploy or a restart only. `X-Frame-Options: SAMEORIGIN` keeps the framing rule in
all modes. `next dev` sends no policy unless `LAB86_CSP_MODE` is set.

## Directives and the reason for each source

| Directive | Sources | Reason |
| --- | --- | --- |
| `default-src` | `'self'` | Fallback for all other fetches. |
| `script-src` | `'self' 'nonce-…' 'strict-dynamic' 'unsafe-eval'` | Only scripts with the nonce run, and the scripts that they load (Clerk, Stripe, Cloudflare Turnstile, the office editor API). `'unsafe-eval'`: the Odoo spreadsheet engine (o-spreadsheet and Owl) compiles templates and formulas with `new Function()`. |
| `style-src` | `'self' 'unsafe-inline' https://fonts.googleapis.com` | Clerk injects CSS-in-JS at runtime (Clerk requires `'unsafe-inline'`). React renders style attributes. The brief frames load Google Fonts stylesheets. |
| `img-src` | `'self' data: blob: https:` | Mail bodies, sender logos and favicons, avatars (Clerk, Google), daily art from museum image hosts, and Convex storage files. |
| `font-src` | `'self' data: https://fonts.gstatic.com` | App fonts are self-hosted. The brief frames use Google Fonts. |
| `connect-src` | `'self'`, Convex `https://` and `wss://` deployment origin, Clerk Frontend API origin, `https://clerk-telemetry.com`, `https://*.clerk-telemetry.com`, `https://*.protect.clerk.com:*`, `https://img.clerk.com`, `https://api.stripe.com`, `https://maps.googleapis.com`, `data:`, `blob:` | Convex live queries, Clerk sign-in and its fraud protection, Clerk billing on Stripe, and local blob and data reads. |
| `frame-src` | `'self' blob:`, the office server origin, `https://www.google.com`, `https://www.browserbase.com`, `https://*.browserbase.com`, `https://challenges.cloudflare.com`, `https://*.protect.clerk.com`, `https://js.stripe.com`, `https://*.js.stripe.com`, `https://hooks.stripe.com` | Attachment and plan previews, file previews, the Collabora editor, calendar maps, the shared browser live view, Clerk bot protection, and Stripe checkout. |
| `worker-src` | `'self' blob:` | The push service worker and Clerk workers. |
| `media-src` | `'self' data: blob:` | Attachment and file previews. |
| `manifest-src` | `'self'` | The web manifest. |
| `object-src` | `'none'` | No plugins. |
| `base-uri` | `'self'` | Stops base tag injection. |
| `form-action` | `'self'`, the office server origin | The Collabora editor opens through a form POST into its frame. |
| `frame-ancestors` | `'self'` | Only the app can frame its pages. |
| `upgrade-insecure-requests` | | Sent on all hosts except plain-HTTP loopback hosts. |

The Convex, Clerk, and office origins come from `NEXT_PUBLIC_CONVEX_URL`, the Clerk publishable key,
and `OFFICE_DOCUMENT_SERVER_URL`. On staging the Clerk proxy (`/__clerk`) is same-origin.

## Other response headers (`next.config.ts`, production builds)

- `Strict-Transport-Security: max-age=31536000; includeSubDomains`
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: SAMEORIGIN`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy`: the camera, screen capture, USB, serial, HID, MIDI, motion sensors, and
  topics are off. The microphone (voice capture) and the location (a capture can send it with
  consent) are for this origin only. The clipboard, fullscreen, payment, and passkeys keep their
  browser defaults, because the Collabora, live-view, Stripe, and Clerk frames get them through their
  `allow` attribute.

No COOP or COEP header is sent. They could break the OAuth popups and Clerk.

## Known scanner findings

A DAST scan (for example OWASP ZAP) can report these items. They are known and have a reason:

- `style-src 'unsafe-inline'`: Clerk requires it for its runtime styles.
- `script-src 'unsafe-eval'`: the spreadsheet engine requires it. To remove it, move the spreadsheet
  editor into its own frame document with its own policy.
- `img-src https:`: mail bodies show images from any host.
