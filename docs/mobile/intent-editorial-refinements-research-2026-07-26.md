# Intent and editorial refinements research — 2026-07-26

## Scope

This pass covers the iOS sidebar scrub, Daily Brief hierarchy and grouping, and inline email results in chat. The implementation keeps Albatross's existing visual language and uses typed, deterministic layout and navigation contracts.

## Mobbin references

### Fixed-selection wheel behavior

- [Strava duration picker](https://mobbin.com/screens/56c282b9-845c-4613-96cf-806c4e35eb73): the selection band stays fixed while values move beneath it; nearby values fade and curve away.
- [Coffee Meets Bagel distance picker](https://mobbin.com/screens/e431385a-19c9-4892-af53-4689c25637b6): a restrained rolling surface communicates depth without adding ornamental chrome.
- [Microsoft Outlook work-hours picker](https://mobbin.com/screens/f38b596b-9583-46f2-b248-2b385fcc5360): the selected row remains face-on while rows above and below recede.

Implementation consequence: the sidebar list follows the drag, the selection point remains anchored, and index selection moves opposite the finger's vertical translation. The existing tap path remains available as the accessible alternative.

### Editorial hierarchy and related updates

- [Apple News lead story](https://mobbin.com/screens/2450aa3b-98e8-45ed-a7bc-afb38e478b73): a stable edition masthead and one dominant story establish reading order.
- [Finimize briefing](https://mobbin.com/screens/cf1d6fda-cf29-4635-aa41-9013a3504bc0): hierarchy comes from placement and scale instead of a wall of equal cards.
- [Particle News related stories](https://mobbin.com/screens/ddeff579-6273-4ce4-8758-4a22fd427b7f): related sources are presented as one cluster rather than repeated peer tiles.
- [The Atlantic edition](https://mobbin.com/screens/1a937f35-7dd7-4cdf-9d18-b27411ee6c3e): the edition name stays stable while the changing editorial statement becomes the lede.
- [Instagram activity grouping](https://mobbin.com/screens/11397cf3-a65b-41d1-9e13-9518ed5cc830) and [Binance activity aggregation](https://mobbin.com/screens/2a613810-3ef7-472e-928d-47802e468d26): repeated actions are summarized with a count and a drill-in trail.

Implementation consequence: Brief Document nodes get bounded `standard`, `wide`, and `feature` footprints. Connected activity from the same semantic episode (including Xcode Cloud builds) is merged into one handoff while preserving every source reference and recommendation.

### Email result presentation

- [Beside inbox](https://mobbin.com/screens/c0c16671-5e23-4aa7-acac-f4640a262c46): sender identity, subject, recency, and a compact snippet are sufficient for a confident open decision.
- [Gmail message detail](https://mobbin.com/screens/6232f192-8823-4c8d-bd51-7a49b7c02cab): subject and sender metadata lead; message content follows in a readable surface.
- [ClickUp Brain result](https://mobbin.com/screens/0a42e4b5-9bda-4be3-a152-15e0112c1f09): a retrieved artifact is embedded in the conversation instead of immediately navigating away.

Implementation consequence: mail retrieval produces an inline card carrying exact account/thread identity. A tap opens the existing mail reader in the web pane or a native sheet on iOS.

## Browser references

- Apple describes a picker as scrollable values with a selected item and supports the wheels presentation: [Pickers](https://developer.apple.com/design/human-interface-guidelines/pickers).
- Apple defines drag as moving a UI element and recommends retaining standard alternatives: [Gestures](https://developer.apple.com/design/human-interface-guidelines/gestures) and [Drag and drop](https://developer.apple.com/design/human-interface-guidelines/drag-and-drop).
- Apple recommends persistent selection feedback in navigational lists and notes that rolling surfaces can communicate list movement: [Lists and tables](https://developer.apple.com/design/human-interface-guidelines/lists-and-tables).
- Apple recommends using placement and reading order to communicate relative importance: [Layout](https://developer.apple.com/design/human-interface-guidelines/layout).

## Acceptance notes

- Sidebar dragging down moves the menu surface down and selects an earlier item; dragging up selects a later item.
- Protected handoffs remain visible even when next-day intent suppresses unrelated optional work.
- Reflection auto-completion is conservative: only a unique, high-confidence candidate match changes source state.
- Editorial sizing is typed and bounded; clients choose responsive pixels.
- Email previews never invent or transform account/thread identifiers.
