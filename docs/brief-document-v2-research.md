# Brief Document v2 — UI research and implementation notes

Date: 2026-07-23

## Product references

The implementation uses these references as pattern input, not as visual copies:

- [Google News daily briefing](https://mobbin.com/screens/91ddbd7e-4cff-4027-b9ac-ee06748f66a3):
  a clear date-led masthead, strong section hierarchy, one dominant story, and dense supporting rows.
- [Matter reading queue](https://mobbin.com/screens/3219924d-0f10-4ff3-aeba-3c170f00612c):
  compact summary information followed by an editorial shelf and denser supporting content.
- [Timepage day view](https://mobbin.com/screens/01287266-ba8d-4a3c-af59-02600ee64df3):
  date-first framing and a legible schedule rhythm.
- [Things 3 task list](https://mobbin.com/screens/c89b824c-7ad7-4fb4-9e0c-44f8af421629):
  high information density with contextual actions disclosed at the item level.
- [Tiimo planning flow](https://mobbin.com/flows/29cf92cd-18f1-4bcc-8cef-28b3e9a18adf):
  a date strip, approachable starting prompts, and a compact task sequence.
- [Evernote desktop home](https://mobbin.com/screens/8c2859dc-f28c-4159-b900-9923e2bc297f):
  mixed content modules held together by consistent spacing and type hierarchy.
- [Asana desktop project](https://mobbin.com/screens/718a4f38-4f7f-4025-b5d9-451d8cba39a5):
  dense operational rows, persistent status, and actions kept near their objects.

## Resulting design decisions

- The document owns editorial hierarchy; the host owns navigation, action safety,
  hydration, theme, and accessibility.
- A single hero is allowed per document. Supporting content uses dense groups,
  rows, grids, timelines, checklists, stats, charts, or shelves.
- Daily, Area, and Work plan documents share the same vocabulary and renderers.
- Actions are divided into immediate-with-undo, review-gated, and navigation tiers.
  Unknown actions are hidden.
- `entity_list` keeps authored framing while hydrating current state in one batched
  request. `query_list` uses a closed six-query catalog and never accepts an
  arbitrary query.
- The `prompt` leaf is available on Daily and Area documents. Submission is always
  review-gated.
- Canvas is an escape hatch, capped at two leaves, sanitized, sandboxed, and
  bridged only through an explicit action allowlist.

## Apple platform direction

Apple's Human Interface Guidelines describe Liquid Glass as a functional layer
for controls and navigation. Brief content therefore uses ordinary SwiftUI
materials (`regularMaterial`/`thinMaterial`) for glass-like surfaces instead of
turning the document body into an ornamental control layer. Navigation remains
native, Dynamic Type is not constrained by fixed text frames, semantic colors
are used throughout, and charts expose an accessibility label.

## Rollout and compatibility

- `BRIEF_DOCUMENT_V2` gates generation. Staging enables it first.
- Every new edition dual-writes deterministic legacy HTML.
- `artifactSource: "document-v2"` selects the native renderer.
- Stored v1 HTML remains readable on web and iOS.
- Future document versions and unknown nodes degrade to accessible title/summary
  fallback content instead of rendering blank.
- Convex additions are optional so an older deployment can read existing data.

## Validation notes

- Contract, repair, limits, action payloads, hydration routes, undo tools,
  renderer degradation, Area generation, plan generation, and plan surface modes
  have focused automated coverage.
- TypeScript type checking and the full Bun test suite are release gates.
- The current Linux workspace has no Swift/Xcode toolchain. The MobileAPI and app
  tests are included for macOS CI; iOS compilation and simulator acceptance must
  run there before production promotion.
- T3's shared preview host was unavailable during the implementation pass. The
  staging deployment is therefore the first authenticated browser acceptance
  environment; do not promote to production until Daily, Area, and Work surfaces
  are visually checked there in light and dark themes.
