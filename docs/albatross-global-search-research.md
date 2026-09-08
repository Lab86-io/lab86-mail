# Global search overlay — 2026-09-08

## Product correction

The requested interaction is a floating search window over the current page, not a shortcut that first switches to Mail. This supersedes the route-to-Inbox decision in `albatross-keyboard-search-area-brief-research.md`; the Area split view and Today Brief work remain unchanged. Native Apple targets are unchanged.

## Research used before implementation

- [Mobbin: Midday web dashboard](https://mobbin.com/explore/screens/fa47d11e-0857-4ddc-a515-c837358b7c68): inspected the public reference in the collaborative browser, including its screenshot. A visible “Find anything” control with a shortcut belongs to the whole workspace, not one content pane. Dedicated Mobbin MCP tools were unavailable; this is public-reference research, not a claimed authenticated Mobbin flow audit.
- [Linear search](https://linear.app/docs/search): official global quick-search guidance informed grouped entity results, explicit source filters, and keyboard-first selection.
- [Notion search](https://www.notion.com/help/search): inspected official guidance in the browser. Its search window combines content discovery with navigating to pages such as Home and Settings. This informed immediate page shortcuts alongside asynchronous content search.

## Implementation decisions

- Reuse the existing Radix Dialog, cmdk, forest-green tokens, spacing and dense result rows. No new dependency or parallel search index.
- Search is visibly available from the rail and Settings. `/` and Command/Control-F open it outside editable controls; Command/Control-P also works while editing. Command-K remains the assistant shortcut.
- Opening and dismissing preserve the underlying page, file editor, area selection and mail query. Escape restores focus. Selection is immediate; it does not wait for an exit animation. Arrow keys wrap through results, Enter opens, Tab stays within the dialog, and asynchronous results receive a usable initial selection.
- Page shortcuts include Today, Albatrosses, Mail, Calendar, Files, Areas, Activity and Settings. Existing compose, theme, mailbox and in-app AI commands remain available.
- Mail fans out to the selected authenticated mailboxes through `search_threads`; result identity includes the owning account. Search operators remain supported. Natural-language interpretation is explicit in the Mail filter rather than invoking an LLM on every keystroke.
- Files combine connected Google Drive/OneDrive name search with the existing recent Albatross document/upload lists. The Files footer states this scope; this is not full-text search of every stored file. Local documents and native Google files use exact editor deep links; other provider files use validated HTTP(S) links.
- Calendar uses `calendar_search_events`, then fetches authoritative `calendar_event_detail` by account + calendar + event. Selection changes the displayed date and opens the existing event viewer, including dates outside the previously loaded calendar window.
- Requests debounce and pass cancellation signals. Sources fail independently, with retry and file-connection recovery. Result navigation clears stale document/area/work URL state. In-place file navigation has a dedicated event, avoiding synthetic browser-back events that would close a mobile mail reader.
- Browser verification exposed an existing cloud browse bug: it forwarded `query`, `folderId` and `cursor` into a strict credential lookup. Only the account/connection identity is now passed, with a regression assertion covering all three extra fields.

## Verification

- 3,190 Bun tests passed, including real helper tests for source mapping, account collisions, partial failures, cancellation, unsafe URL rejection, navigation/state preservation, transient calendar selection, and the browse argument boundary.
- All three new search logic modules have 100% line/function coverage. API client coverage is 95.65% lines with explicit cancellation/backwards-compatibility/error tests.
- Typecheck and repository-wide Biome checks passed.
- Authenticated collaborative-browser checks against the development corpus: real mail search and reader opening; real calendar search and detail opening on its date; real local document search and editor opening; page switching to Calendar, Mail and Settings; search available on Today, Calendar, a file editor and Settings; Command-F, Control-F, Command-P, Control-P, slash, arrow/Enter selection, Tab containment, Escape dismissal and focus return.
- Visually inspected desktop light/dark overlays and a 390×844 narrow viewport; the dialog fits without horizontal overflow.
- Connected Google Drive reaches the provider after the argument fix, but the development account's refresh credentials have expired. The UI reports the reconnect requirement while retaining local file results. A successful live Drive search/open cannot be claimed until the account is reconnected. Google-native/external destination mapping and partial-provider failures are covered by automated tests. No OneDrive connection was available for a live test.

Build, CI and staging deployment evidence are recorded on the PR after verification. Production is not part of this rollout.
