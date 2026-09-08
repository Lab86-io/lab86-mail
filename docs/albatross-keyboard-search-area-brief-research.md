# Keyboard search, Area split, and Today Brief — research notes

**Date:** 2026-09-04

**Platforms:** Albatross web and macOS; iPhone is an explicit non-goal.

**Request:** Make search prominent and keyboard-first, replace the Area Brief /
Inbox tabs with a simultaneous two-column view, and restore Today to a
Brief-first experience.

## Current-product findings

- The web rail's **Search** button opens `CommandPalette`, whose visible query
  only filters commands, mailbox presets, and a short recent-thread list. It
  does not run the product's full mail search. Selecting a mailbox preset also
  does not guarantee that the Mail surface is visible.
- `/` attempts to focus an Inbox input by placeholder. It is a no-op whenever
  Inbox is not mounted (for example, on Today or an Area), and the selector
  makes the shortcut depend on copy.
- The real Inbox search already supports typed operators, natural-language
  translation, cross-account results, Enter to submit, and Escape to clear.
  The right implementation is one global route/focus contract into this
  authoritative search, not a second search engine.
- Area Home currently makes Brief, Albatrosses, and Inbox mutually exclusive
  views behind a tab-like switcher even though the brief and its filed mail are
  complementary context.
- Today currently puts a live dashboard layer before the generated Brief and
  embeds the Brief far below it. The existing `DailyReport` / `BriefCanvas` is
  already the stronger editorial experience and should regain primary status.

## Mobbin references (web)

- [Midday — Dashboard Overview](https://mobbin.com/explore/screens/fa47d11e-0857-4ddc-a515-c837358b7c68):
  a persistent, top-level “Find anything…” affordance prints `⌘K` inside the
  control. Search is visually available before a user needs it, and its
  keyboard path is taught in place.
- [Front — Inbox Email Thread](https://mobbin.com/explore/screens/3e29dd35-0c1d-4f71-831b-af35c13bf1ec):
  navigation, message list, and selected conversation remain simultaneously
  visible. Columns are separated by structure and spacing rather than a
  mode-switching tab bar.
- [Lemni — Initial Inbox View](https://mobbin.com/explore/screens/68aa3af4-c84d-4a60-bffc-8e3935bc4b63):
  inbox list, working content, and supporting details coexist as a desktop
  workbench. The result preserves context while the user scans and acts.
- [Better Stack — Monitors Search Filter](https://mobbin.com/explore/screens/0230b942-cf7e-4c79-a4b0-befa091cf866):
  focused search stays attached to the data it narrows, selection is visible,
  and keyboard users can refine without changing screens.

Mobbin's dedicated MCP search tools were not available in this session. The
same public Mobbin records were inspected through the collaborative browser and
their original 1920px screen images, so the visual findings above still come
from Mobbin rather than reconstructed descriptions.

## Browser-based product research

- [Linear Search](https://linear.app/docs/search): `/` opens workspace search;
  `⌘/Ctrl+F` searches the current list, board, or Inbox; Escape clears the
  in-view search. The visible search button and shortcuts resolve to the same
  search model.
- [Superhuman Search](https://help.superhuman.com/hc/en-us/articles/46005672652301-Search):
  desktop search is available from the keyboard-first command path and supports
  direct queries plus operators; the user does not need to navigate to a
  dedicated search page first.
- [Superhuman shortcuts](https://help.superhuman.com/hc/en-us/articles/46005789591693-Speed-Up-With-Shortcuts):
  the command surface teaches shortcuts as users discover actions, and Escape
  returns to the inbox. This supports showing the shortcut on the affordance
  and retaining predictable dismissal.
- [Apple Mail viewing settings](https://support.apple.com/en-gb/guide/mail/cpmlprefview):
  macOS Mail treats column layout and the preview area as a normal desktop
  reading model. That supports Brief/context on the left with its Inbox on the
  right for the native app.

## Frozen interaction decisions

1. **One authoritative global search.** The visible Search control and global
   keyboard shortcuts route to Mail and focus the real Inbox search input.
   Keep the existing query parsing, natural-language translation, account
   scope, and result list. Do not add a competing search store or endpoint.
2. **Discoverable shortcuts.** Show the platform shortcut on the visible
   Search affordance. Support `/` for fast global search and `⌘/Ctrl+F` as the
   conventional find action. Do not steal shortcuts while a text editor,
   select, or content-editable element owns focus. Escape keeps its existing
   clear/close semantics.
3. **Area desktop workbench.** At desktop width, render the current Area Brief
   in the left column and the filed Area Inbox in the right column at the same
   time. Remove the Brief/Inbox tab switch. Keep narrow layouts usable through
   an adaptive stack and preserve access to existing Area work without turning
   it into a second primary tab rail.
4. **Today is the Brief.** Make the existing full Brief document the main Today
   surface again, including its masthead, actions, loading/error/legacy paths,
   and refresh behavior. Live Today data may remain only if it is genuinely
   subordinate and does not delay or visually precede the Brief.
5. **Accessibility and tests.** Search must have a stable semantic target,
   explicit label/help text, visible focus treatment, and no placeholder-based
   DOM contract. Add focused tests for routing/focus and any extracted Area
   layout state. Preserve iPhone behavior.

## Browser acceptance — 2026-09-08

Verified the local development build in the collaborative browser using an
authenticated staging identity with four connected mailboxes (real results,
not mocked search responses).

- Typed `subject:Railway` returned 12 threads. Natural-language search returned
  13 threads with the translated filter and original wording visible.
- `/`, Command-F, and Control-F route to the real search field. Tested entry
  from Today, Areas, Calendar, Files, Activity, and Albatrosses, including a
  previously unmounted Inbox. Reopening search selects the existing query.
- Arrow Down enters the results; Up/Down traverse them with a visible focus
  indicator. Enter opens the focused thread. Escape closes the reader; in the
  search input, Escape clears the query, then a second Escape leaves the field.
- Reviewed light/expanded and dark/collapsed desktop layouts at 1280 × 800.
  The top-level Search action stays visible and collapsed keycaps do not spill
  outside the rail. At 390px, the sidebar closes and hands focus to search;
  there is no document-level horizontal overflow.
- A no-results typed query shows “No mail matched your search,” without
  natural-language-only recovery actions. The generated-filter recovery path
  remains available for natural-language queries.
- Area Brief and Inbox are visible together at desktop width. Corrected the
  Brief's top inset so its heading is not covered by the floating controls.

Acceptance fixes include a durable mount-aware search focus request, mobile
sidebar close/focus coordination, arrow traversal of thread rows, composition
guards, and truthful typed-query empty-state copy. Focused regression tests
cover the shared shortcut/focus contract and the Area/Today layout boundaries.

Validation before staging: web lint, typecheck, and optimized production build
passed; the full Bun suite passed with 3,158 tests, with 100% line/function
coverage on the new search-focus contract. Native macOS and iPhone
simulator builds passed during implementation. Native test execution remains
blocked by the pre-existing `DevelopmentAPIOverrideTests` initializer mismatch;
no iPhone UI change is intended.
