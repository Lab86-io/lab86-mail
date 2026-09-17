# Native shell with shared web capabilities

Implementation branch: `feat/native-web-feature-parity`, based on staging `c56b58e0`.

The iOS and macOS apps keep their SwiftUI navigation, quick editors, system authentication,
file pickers, and sharing. Advanced capabilities open the existing web surfaces in an
isolated in-app WKWebView. There is one implementation of the advanced editing engines,
with the same permissions, saved documents, revisions, and provider configuration as web.

## Capability access

| Capability | iOS and macOS entry point | Shared implementation |
| --- | --- | --- |
| Document formatting, revision history, export, AI editing | File → All editing tools | `DocumentEditor`, rich text engine, assistant |
| Spreadsheet formulas, charts, pivots, formatting, validation and export | Spreadsheet → All editing tools | Existing Odoo spreadsheet engine |
| Presentation artwork, charts, theme, layouts, transforms and export | Presentation → All editing tools | Existing web presentation editor |
| Full Office editing, upload and provider files | Files → Full file library | `FilesSurface` and configured Office provider |
| Google documents, sheets and slides | Google file → All editing tools | Existing Google editor and provider operations |
| Today, Tasks, Work, Calendar, Mail | Workspace toolbar → All tools | Full web workspace for the selected destination |
| Additional settings and integrations | Settings → All settings | Existing web settings |
| Other web destinations, including Chat | Navigate within All tools; Mac also has ⇧⌘E | Existing web application |

The native quick editors remain available. Their draft must finish saving before its full
editor opens; the document reloads on return. The general workspace shortcut is disabled
while a document is open so it cannot bypass that save. Work and Area destinations keep
their selected context. The native stores refresh after leaving the full workspace.

Full editors require connectivity, just as they do on web. Office and provider features
remain subject to the same server configuration and account permissions. This is shared
feature access, not a rewrite of every editing control in SwiftUI.

## Authentication and data integrity

- A native Clerk bearer session requests a single-use, 60-second sign-in ticket for its
  authenticated user. The ticket stays in memory and never enters a URL or application log.
- The bootstrap bridge accepts messages only from the main frame at the exact app origin
  and `/native/session`. Its destination is restricted to product routes. The activated
  browser account must match the native account.
- Every workspace has a nonpersistent WKWebsiteDataStore. Closing requests revocation of
  its separate Clerk session; the native session cannot be revoked by this endpoint.
  Revocation is best effort when offline. The browser data store is still discarded.
- Staging's Basic password is never copied into WebKit. A signed, origin-bound, one-hour
  cookie passes only that outer gate; Clerk still authenticates every protected request.
  Native bearer requests renew the cookie before expiry and after foregrounding.
- Provider authorization uses the existing native authentication coordinator. External
  links open through the system. Browser confirmations, prompts, file upload, and exports
  have native delegates. Asynchronous download anchors are forwarded to
  [WKDownload](https://developer.apple.com/documentation/webkit/wkdownload) in the
  current browser context, including blob URLs, so an expired transient DOM user gesture
  does not prevent an export. URLs must belong to the app origin; filenames are sanitized.
  Policy cancellations from downloads/external links do not replace the editor with an error.
- Closing warns when an editor has unsaved changes. Unknown save state also asks before
  closing, and swipe dismissal is disabled while editing.
- Convex rejects a V2 presentation overwritten by a V1 projection, even when an old client
  requests downgrade. A failed save leaves both the document and revision history intact.
  Title-only updates and full V2 saves remain valid.

## Validation

Final local results: 3,986 web tests passed (one existing artwork test skipped), 474
Swift Testing cases passed on iOS, and 446 passed on macOS. The iOS XCTest rendering
suite also passed. Typecheck, lint, production build and browser checks passed.
Lint retains one existing image-element warning and two existing informational notices.

- Web typecheck, lint and production build.
- Repository CI command `bun run test:coverage`, with its default timeouts; the full suite passes.
- Focused auth, renewal, session cleanup, destination, file-link and lossy-save tests;
  the new `lib/native` helpers have 100% line and function coverage.
- Native unit suites on iOS 27 simulator and macOS 27. Real WKWebView integration uses
  synthetic HTTP and identity fixtures to exercise bootstrap, account binding, ephemeral
  storage, cookie renewal, save-state messages, external navigation, dialogs, HTTP and blob
  exports initiated through actual DOM download links, and session cleanup. Runtime selector
  checks verify that optional WebKit delegates are registered, including macOS file upload.
- `ALBATROSS_PREVIEW_PORT=18849 bun run dev:preview`, then
  `node scripts/check-native-workspace-browser.mjs` checks the actual Files/editor and
  assistant components at 390×844 and 1440×1000. Screenshots default to
  `/tmp/lab86-native-workspace`. This uses synthetic data and does not edit a real account.
- The generated Xcode project is refreshed from `apps/ios/project.yml`, including existing
  staging sources that were absent from its checked-in project.

No web visual redesign is introduced: the embedded screen composes the existing Files
and assistant surfaces. Browser review checks their layout inside the new container.

## Staging → main rollout

1. Deploy the Convex V2 downgrade guard first. No schema migration or document rewrite is
   required. Confirm old projection saves fail without adding a revision.
2. Deploy the web/API changes to staging. Confirm Clerk configuration and the existing
   `LAB86_CONVEX_INTERNAL_SECRET` are present. Keep staging Basic auth enabled.
3. Publish paired iOS/macOS testing builds against that staging deployment. Verify with
   a real signed-in account: open each editor without another sign-in, edit and reopen
   on web, restore a revision, export and share, upload an Office file, reconnect a
   provider, background/resume, and switch accounts. Confirm closing the embedded
   workspace leaves the native login active. These authenticated/provider acceptance
   checks are a release gate; local synthetic tests do not substitute for them.
4. Promote the matching Convex and web commits to main before releasing Apple builds
   pointed at production. Preserve the repository's existing release/version process.
5. If native integration must be rolled back, keep the server session routes compatible
   with shipped builds and retain the downgrade guard. Reverting the guard would expose
   rich presentations to old-client data loss again.

This branch does not deploy, merge staging into main, or publish an Apple build.
