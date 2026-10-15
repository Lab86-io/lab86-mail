# Albatross product updates research

## Visual follow-up and frontend design skill

Latest correction: Jakob wants the summaries themselves to contain an HTML demo
of their release’s changes. The previous generic Summary/Full details example
did not communicate that clearly. A summary is now structured data with required
`text` and `demo` fields. Its live demonstration renders inside the summary region,
above the closed full change list. Supplemental media belongs with the full notes.
The concrete summary demonstrates this release’s new update notice: open the
notice while keeping the current work in place, then review its changes. Future
summary authors must demonstrate the actual feature changed in their release.

Jakob requested pictures or HTML demonstrations and explicitly asked for the
frontend design skill. Loaded the installed
`/home/jjalangtry/.claude/skills/frontend-design/SKILL.md`.

Design plan before implementation:

- Color: canvas `#f6f8fb`, paper `#ffffff`, text `#17202a`, secondary text
  `#5d6b7a`, forest `#0f5132`, soft forest `#e5f2eb`. These are the existing
  Albatross tokens rather than a new brand palette.
- Type: the existing Fraunces display face and Geist body face; retain the
  compact product text scale and left alignment.
- Layout: keep the reading column and give the change a working demonstration.
  The image or demo precedes the expandable details. In the demo, one control
  switches between the summary and the complete list.

```text
Option A: static illustration       Option B: working demonstration (chosen)
Date / change count                Date / change count
Title + summary                    Title + summary
[ screenshot ]                     [ Summary | Full details ]
Caption                            [ actual changing content ]
Expand all changes                 Caption / Expand all changes
```

- Principle: spend the visual emphasis on showing the exact change. Use actual
  rendered product screenshots and native HTML controls, with plain captions.
  Keep decoration and surrounding navigation quiet.

Review against the brief: a static mock inside a mock was too indirect. Replace
it with an operable summary/details example and support real screenshot assets
as a separate preview format. Keep scripts disabled inside the HTML frame;
native HTML controls can demonstrate this interaction without scripts.

## Request and product fit

Add a product update system like Sprebuild’s, with small HTML renders for visual
changes. Jakob confirmed that batches with **more than three changes** should
start with an expandable summary; one to three changes stay visible.

Inspected the existing Albatross `Rail`, Settings, NotificationCenter, app shell,
theme tokens, version module, and release workflow. A quiet entry beside Settings
fits the current navigation density. A dedicated narrow feed gives previews room
without mixing product announcements into notifications about the user’s work.
Use the existing forest accent, semantic surface colors, display font, and compact
body type. Avoid automatic modal interruptions.

## Sources and access limits

- [Linear changelog](https://linear.app/changelog): dated feature sections pair
  concise explanations with product images, followed by categorized fixes and
  improvements. Apply the dated batches, explanation-plus-preview pairing, and
  access to full details; keep Albatross’s reading surface much smaller.
- [Raycast changelog](https://www.raycast.com/changelog): versioned releases with
  highlights and separate details provide a useful release-history reference.
- The Mobbin UI research skill was loaded, but this session exposes neither
  Mobbin `search_screens` nor `search_flows`. No Mobbin findings are claimed.
  The attempted Mobbin web changelog browse URL was unavailable as well.
- T3 `preview_open` returned: “This host blocks the sandbox T3’s browser runs in
  (AppArmor on Ubuntu 23.10+).” Official pages were read through the web tool;
  Raycast was also inspected in installed Chromium: releases use distinct New,
  Improvements, and Fixes headings. Local browser verification uses installed Playwright/Chromium as the explicit
  unavailable-browser fallback. No host security settings were changed.
- Sprebuild was read over SSH on `lab86` at
  `/Users/jakob/statpearls/repos/sprebuild`: `docs/UPDATES.md`,
  `components/updates/AppUpdates.tsx`, and the release receipt/discovery flow.
  Its `sprebuild-changelog-summary` checkout was also inspected:
  `components/updates/Changelog.tsx`, `lib/releases/summary.ts`, and its summary
  endpoint. The baseline ships agent-authored notes; the summary branch also
  offers on-demand AI summaries across multiple entries.

## Decisions

1. `/updates` holds dated batches and optional known release versions. The sidebar
   entry is a client navigation. Keep the existing authentication boundary.
2. Four or more changes require a reviewed plain-language summary. Native
   `details` gives keyboard-accessible expansion and works before hydration.
3. HTML previews sit outside the collapsed change list so the summary includes
   a visual at a glance. A plain-language caption explains each preview.
4. Version-controlled HTML fragments render in an opaque sandboxed iframe with
   a restrictive CSP. Small previews use fictional data, no live app controls.
5. The unread indicator is a quiet dot. A local receipt updates only on visiting
   the feed; it synchronizes across tabs and survives reloads.
6. Content is authored with the code and validated in tests. This first version
   does not invent historical releases or claim to automatically write notes.
7. Adopt Sprebuild’s same-origin discovery, review-before-reload, Later behavior,
   and revalidation when a reviewed release has been superseded. Use Albatross’s
   existing query infrastructure for visible-tab polling and reconnect checks.
   Do not copy its Supabase/Vercel infrastructure into this Convex/Railway app.
   Agent-authored summaries ship with the changes here; the user-confirmed
   threshold is strictly more than three changes.

These notes belong with the PR so reviewers can assess both the chosen patterns
and the unavailable research sources.

## Verification

- The full Bun suite passes: 3,377 tests across 334 files. Provider keys were
  explicitly blanked for the run so the existing no-provider tests are deterministic.
- Focused tests cover the strict three/four boundary, feed validation, date
  stability, preview sandbox/CSP, receipt synchronization and blocked storage,
  manifest parsing, uncached discovery, and rollback note selection.
- Chromium checks exercised keyboard disclosure, receipts, 320px and 360px
  layouts, dark appearance, same-build silence, Later, superseded releases, and
  failed rechecks. The notice used an isolated component harness with the app’s
  providers: the existing no-auth app shell calls `useConvexAuth` without an auth
  provider. The temporary harness was removed after checking.
- A clean snapshot of tracked source plus this change compiled and built for
  production, including the final preview theme fix. Full lint in that snapshot
  also passes (1,059 files), and focused update logic has 100% line coverage.
  The working tree’s full typecheck is independently blocked by an
  existing untracked `lib/mail/art-types.ts` importing a missing `art-style` module.
  Its full lint is blocked by the existing nested Biome root configuration under
  `.claude/worktrees/chat-agentic-pass`. Targeted lint passes for every changed
  implementation and test file. A typecheck excluding only that unrelated
  untracked file also passes.
- The interactive static preview is published on the Mac mini at
  [files.lab86.io](https://files.lab86.io/albatross-updates-2026-10-15/index.html).
  HTTPS returns 200; Chromium verified its expansion and appearance controls.
  The preview has no app runtime or data connections. This work is not deployed.
- The visual follow-up adds a screenshot format with required alt text and
  dimensions, checks asset existence, and explicitly opts HTML demos into pointer
  and keyboard interaction while keeping scripts disabled. The new entry’s three
  changes remain visible; the original five-change entry stays summarized.
  Chromium verified actual radio controls, arrow-key selection, picture loading,
  dark appearance, and 320px/360px layouts with no page errors. Fresh clean-snapshot
  typecheck and full lint both pass. The new picture and interactive demonstration
  are published at
  [the visual examples](https://files.lab86.io/albatross-updates-visuals-2026-10-15/demo.html).
- After the clarification, model tests require each summary’s own HTML demo and
  reject plain text or a screenshot in its place. UI tests assert that the demo
  belongs to the visible summary while full notes and supplemental media stay
  collapsed. Chromium verified the integrated notice demo with Enter and pointer
  interactions, 320px/360px layouts, dark appearance, and no page errors. Updated
  clean-snapshot typecheck and full lint pass; focused update logic retains 100%
  line coverage. The corrected standalone artifact uses the actual rendered
  summary component and is published at
  [the summary with its own demo](https://files.lab86.io/albatross-summary-demo-2026-10-15/index.html).
