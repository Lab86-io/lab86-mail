# Swift library evaluation — mobile UI round 2026-07-20

Scope: SwiftUI iOS app (`apps/ios`, deployment target iOS 27.0, Swift 6, strict concurrency
complete, XcodeGen `project.yml`, SwiftPM only). Research date: 2026-07-20.

Context that shaped every verdict:

- **Every new SwiftPM dependency is a CI risk.** Xcode Cloud has already burned us on plugin
  trust prompts, compiler crashes, and the SwiftStreamingMarkdown branch-pin dance. Native
  iOS 26/27 APIs win whenever quality is comparable.
- Deployment target is iOS 27, so **everything introduced at iOS 26 or earlier is freely
  usable** — no availability guards needed for Liquid Glass, rich-text `TextEditor`,
  SwiftUI `WebView`, `MeshGradient`, `ConcentricRectangle`.
- Already in the graph (`apps/ios/project.yml`): SwiftSoup `exact 2.7.0`,
  microsoft/SwiftStreamingMarkdown (branch `main`), HorizonCalendar, Kingfisher `from 8.1.0`,
  Clerk, ClerkConvex, Convex. Xcode Cloud requires a committed `Package.resolved`.

Reference screenshots in `refs/` (listed at the bottom).

---

## 1. Chat UI + streaming markdown

### exyte/Chat (ExyteChat) — SKIP

| | |
|---|---|
| Repo | https://github.com/exyte/Chat — 1.8k stars, MIT |
| Maintenance | Active. Latest tag `3.2.4` (2026-07-16); note GitHub *Releases* page is stale (2.1.4, Jan 2025) — versions ship as tags. |
| SwiftPM | Yes. `swift-tools-version: 6.1`, min iOS 17. |
| Dependencies | exyte/MediaPicker, exyte/ActivityIndicatorView, **Giphy/giphy-ios-sdk `exact 2.2.16` (closed-source binary xcframework)**, Kingfisher `from 8.5.0`. |

Verdict: **skip.** ExyteChat is a messenger-shaped kit (media picker, GIF picker, reply
swipes, read receipts) — the wrong shape for a ChatGPT-style assistant. The dealbreaker is
the mandatory Giphy binary SDK dependency: a closed-source xcframework is exactly the kind
of Xcode Cloud resolution/signing risk we're avoiding, and we'd use none of its features.
We already have a native assistant chat (`Lab86Mail/Features/Assistant/AssistantChatView.swift`
renders streaming replies with SwiftStreamingMarkdown); polishing that view is cheaper and
safer than adopting a framework and fighting its cell customization API.

Alternatives checked: GetStream/stream-chat-swiftui (commercial SDK tied to Stream's backend
— non-starter), EnesKaraosman/SwiftyChat (Apache-2.0, 4.1.1 Apr 2026, 348 stars — same
messenger shape, smaller community), YoungHypo/ConversationKit (0 stars, toy). Nothing in the
ecosystem beats a hand-rolled ChatGPT-style transcript: `ScrollView` +
`defaultScrollAnchor(.bottom)` / `scrollPosition`, `glassEffect` input bar, streaming
markdown body.

### Streaming markdown: keep microsoft/SwiftStreamingMarkdown — KEEP (already adopted)

| | |
|---|---|
| Repo | https://github.com/microsoft/SwiftStreamingMarkdown — MIT, very active (pushed 2026-07-19) |
| Releases | `v0.6.0` 2026-07-16, `v0.5.0` 2026-07-09 — rapid cadence. Min iOS 16. |
| Pin status | Branch-pinned `main` in `project.yml`. **Checked v0.6.0's `Package.swift`: it still pins `appstefan/highlightswift` and `junyan72/iosMath` by `revision:`.** Revision pins are "unversioned" to SPM just like branch pins, so a stable-version consumer would still be rejected — the branch-pin workaround in `project.yml` **must stay** for now. Re-check each release; the moment upstream moves those two to tagged versions we should pin `from: "0.x"` for reproducible Xcode Cloud builds. |

Verdict: **keep.** Purpose-built for token-streaming rendering (incremental parse, no
full-document reflow per token), ships syntax highlighting (HighlightSwift), math (iosMath),
and even shimmer for pending blocks (it depends on markiv/SwiftUI-Shimmer `exact 1.5.1` —
relevant for need #6). Actively developed by Microsoft.

### gonzalezreal/swift-markdown-ui (MarkdownUI) — SKIP

| | |
|---|---|
| Repo | https://github.com/gonzalezreal/swift-markdown-ui — 3.9k stars, MIT |
| Maintenance | **Maintenance mode** — repo description says so explicitly; last release 2.4.1 (Oct 2024). Successor is https://github.com/gonzalezreal/textual (MIT, 0.5.0 Jun 2026, min iOS 18). |
| SwiftPM | Yes, min iOS 15, depends on swift-cmark (C target) + NetworkImage. |

Verdict: **skip.** It's the best static-markdown renderer of the iOS 15–18 era, but it is
explicitly in maintenance mode, is not designed for streaming (re-parses the whole document
on change), and would duplicate what SwiftStreamingMarkdown already does in the app.
**Textual** (the successor) is worth a look in a future round once it hits 1.0 — today it's
0.x and would be a second markdown stack for no gain.

**Net for need 1: zero new dependencies.** Build the ChatGPT-style chat natively on the
existing SwiftStreamingMarkdown renderer.

---

## 2. Quick capture / bottom sheets + animation delight

### Native sheets — USE NATIVE

`presentationDetents` (iOS 16+) plus `presentationBackground`, `presentationCornerRadius`,
`presentationDragIndicator`, `presentationBackgroundInteraction` (iOS 16.4+) cover the whole
quick-capture surface. On iOS 26+ sheets automatically get Liquid Glass treatment and
device-concentric corners; inset content can match with `ConcentricRectangle` (see need 5).
Custom detents via `CustomPresentationDetent` handle "capture bar → expanded editor" states.
Third-party sheet libraries were built for the pre-16 era and now fight the system look —
none evaluated survives contact with iOS 26's glass sheets.

Verdict: **native, no library.** No detent-library gap remains on iOS 27.

### EmergeTools/Pow — ADOPT (selectively, optional)

| | |
|---|---|
| Repo | https://github.com/EmergeTools/Pow — 4.3k stars |
| License/cost | **MIT, free.** Originally a paid product by Moving Parts; EmergeTools acquired it and open-sourced it under MIT in 2023. No license key, no cost. |
| Maintenance | Latest release `1.0.6` (2026-04-13). Stable, mature — infrequent releases because it's done, not dead. |
| SwiftPM | Yes, min iOS 15, `swiftLanguageVersions: [.v5]` (builds in Swift 5 mode; fine alongside our Swift 6 app target). Only dependency is EmergeTools/SnapshotPreviews-iOS `exact 0.10.21`, gated behind a compile-time flag that defaults off — resolved into `Package.resolved` but not built. Pure Swift, no binaries, no plugins. |

Verdict: **adopt if we want transition/feedback delight; otherwise native springs.** Pow's
change effects (`.changeEffect(.shine)`, `.spray`, `.jump`, `.shake`) and transitions
(`.movingParts.blur`, `.pop`, `.swoosh`) are genuinely expensive to hand-build and are the
kind of "task captured" feedback a quick-capture flow wants. CI tradeoff: this is the one
new dependency in this round whose payoff justifies the risk — small, pure-Swift, MIT,
exact-pinnable, no build plugins. If we decide the app doesn't need particle/shine effects,
native `spring(duration:bounce:)`, `PhaseAnimator`, and `KeyframeAnimator` (iOS 17+) plus
`glassEffectTransition` cover the basics for free.

Coordinates if adopted:

```yaml
Pow:
  url: https://github.com/EmergeTools/Pow
  exactVersion: 1.0.6
```

### Glass/material effects — USE NATIVE

Covered by iOS 26 Liquid Glass (need 5). Do not add any "glassmorphism" library.

---

## 3. Rich email thread rendering

### Keep SwiftSoup (2.7.0) preprocessing + move to native SwiftUI WebView — USE NATIVE + EXISTING

- **SwiftSoup** (https://github.com/scinfu/SwiftSoup, MIT, 5.1k stars, pushed 2026-07-06,
  already pinned `exact 2.7.0`) stays the sanitization/preprocessing layer: strip trackers,
  inline dark-mode CSS, collapse quoted history (`blockquote`, `.gmail_quote`,
  `#divRplyFwdMsg`, etc.) before handing HTML to the web layer.
- **SwiftUI `WebView` / `WebPage` (iOS 26+, WebKit framework)** — native replacement for our
  `UIViewRepresentable` WKWebView wrappers in `Features/Mail/EmailHTMLView.swift` and
  `Features/Today/DailyBriefView.swift`. `WebPage` gives observable navigation state,
  `callJavaScript`, custom `URLSchemeHandler`, and `NavigationDeciding` — the pieces we
  currently hand-roll (nonce bridge, height reporting). Docs:
  https://developer.apple.com/documentation/webkit/webview-swift.struct (iOS 26.0+).
  Migration is optional and incremental; the existing wrapper works. No third-party WKWebView
  helper library earns a place — the category (e.g. old "MarkdownView"-style wrappers) is
  stagnant and the native API obsoletes it.

### Collapsible message sections — NATIVE

No credible library exists for mail-thread collapse specifically. Native SwiftUI covers it:
`DisclosureGroup` or custom `@State` expand/collapse per message with
`animation(.spring)` + `glassEffect` headers; quoted-text folding happens at the SwiftSoup
layer (wrap detected quote blocks, toggle via JS bridge or pre-split into separate native
sections). Verdict: **no dependency.**

---

## 4. Email compose — rich text editor

### Native TextEditor + AttributedString (iOS 26) — USE NATIVE

iOS 26's `TextEditor(text: Binding<AttributedString>, selection: Binding<AttributedTextSelection>)`
provides native rich-text editing: bold/italic/underline, fonts, colors, alignment,
`AttributedTextFormattingDefinition` to constrain allowed attributes (perfect for "lightweight
compose": permit bold/italic/underline/links, nothing else), and integration with the system
Format panel. References: Apple doc `swiftui/texteditor/init(text:selection:)` (iOS 26.0+),
WWDC25 session 280 "Code-along: Cook up a rich text experience in SwiftUI with
AttributedString". Outbound conversion: walk the `AttributedString` runs to emit the small
HTML subset our send path needs (a ~100-line pure function, trivially unit-testable — add
tests when built).

### danielsaidi/RichTextKit — SKIP

MIT, 1.3k stars, release `1.2` (Apr 2025), min iOS 15, SwiftPM fine. But its own README now
carries a maintainer notice: *"with the new iOS/macOS 26 releases, we can now edit attributed
strings with a TextEditor… It will most likely not be updated in its current direction… I am
not yet sure if I will keep this library alive."* Adopting a library whose author is
questioning its future, to replicate what our minimum OS ships natively, is strictly worse.
**Skip.**

### wordpress-mobile/AztecEditor-iOS — SKIP

MPL-2.0, 669 stars, release `1.20.0` (Feb 2025), min iOS 13, SwiftPM supported (`Aztec` +
`WordPressEditor` products). It's a heavyweight UIKit HTML editor built for WordPress
post authoring — full HTML round-tripping, media attachments, plugin system. Massive
overkill for lightweight mail compose, UIKit-bridged, MPL file-level copyleft adds license
review friction. **Skip.**

**Net for need 4: zero new dependencies.**

---

## 5. Depth / visual polish — USE NATIVE (all of it)

Everything in this category is first-party at our deployment target; adding any dependency
here would be pure CI risk for zero quality gain.

- **Liquid Glass** (iOS 26+, SwiftUI):
  - `.glassEffect(_:in:)` — default `.regular` glass in a `Capsule`; variants
    `.glassEffect(in: .rect(cornerRadius: 16))`, `.glassEffect(.regular.tint(.orange).interactive())`.
  - `GlassEffectContainer(spacing:)` — required for performance when multiple glass views
    coexist; controls shape blending/merging distance.
  - `glassEffectID(_:in:)` + `GlassEffectTransition` (`matchedGeometry`, `materialize`) —
    morph animations between glass elements (quick-capture button → sheet is exactly this).
  - `glassEffectUnion(id:namespace:)` — fuse several views into one glass capsule (toolbar
    clusters, our rail docks).
  - `buttonStyle(.glass)` / `.glassProminent`.
  - Apple guidance: limit simultaneous glass effects; apply `glassEffect` after appearance
    modifiers. Docs: https://developer.apple.com/documentation/SwiftUI/Applying-Liquid-Glass-to-custom-views
    and https://developer.apple.com/documentation/TechnologyOverviews/adopting-liquid-glass.
  - Already in use: `AppShellView.swift`, `ThreadView.swift` use `glassEffect`; expand from there.
- **ConcentricRectangle** (iOS 26+, `swiftui/concentricrectangle`) — corners concentric with
  the container/device shape (`.rect(corners: .concentric, isUniform: true)` style API +
  `containerShape(_:)` on the parent). This is the correct way to do "card near screen edge"
  corner curvature — replaces hard-coded continuous radii at screen edges. Already used in
  `AppShellView.swift`.
- **Continuous corner curves** (iOS 13+): `.clipShape(.rect(cornerRadius: r, style: .continuous))`
  for elements not tied to a container edge.
- **MeshGradient** (iOS 18+, `swiftui/meshgradient`) — 2D grid of positioned colors with
  Bezier-interpolated patches; animate control points via `TimelineView` for living
  backgrounds (brief masthead, empty states). Native, GPU-rendered.
- **Layered shadows**: stack multiple `.shadow(color:radius:x:y:)` modifiers with increasing
  radius/decreasing opacity (2–3 layers ≈ realistic ambient+key light). No library needed;
  wrap in a custom `ViewModifier` (`.elevated(level:)`) for consistency.

**Net for need 5: zero new dependencies.**

---

## 6. Skeleton / shimmer loading

### markiv/SwiftUI-Shimmer — ADOPT (zero-marginal-cost)

| | |
|---|---|
| Repo | https://github.com/markiv/SwiftUI-Shimmer — 1.7k stars, MIT |
| Maintenance | Last release `1.5.1` (2024-08-14), last push Aug 2024. Dormant — but it's ~200 lines, dependency-free, feature-complete, min iOS 13. |
| Key fact | **Already in our dependency graph**: SwiftStreamingMarkdown v0.6+/main depends on `markiv/SwiftUI-Shimmer` `exact: 1.5.1`. Declaring it directly at the same pin adds no new resolution to `Package.resolved` — zero marginal CI risk — and makes `import Shimmer` legal in app code. |

Verdict: **adopt at the exact pin already in the graph**, and pair with native
`.redacted(reason: .placeholder)` for the skeleton shapes:
`view.redacted(reason: .placeholder).shimmering()` is the standard pattern. If we ever drop
SwiftStreamingMarkdown, reevaluate (dormancy would then count against it; the native-only
fallback is `.redacted` plus a small in-house animated-mask modifier).

Coordinates:

```yaml
Shimmer:
  url: https://github.com/markiv/SwiftUI-Shimmer
  exactVersion: 1.5.1
```

(product name: `Shimmer`)

---

## Summary table

| Need | Verdict | Dependency delta |
|---|---|---|
| Chat UI | Native transcript view; keep SwiftStreamingMarkdown for streaming replies | 0 |
| ExyteChat / MarkdownUI / RichTextKit / Aztec | Skip (Giphy binary dep / maintenance mode / author-deprecated / overkill) | 0 |
| Quick capture sheets | Native `presentationDetents` + iOS 26 glass sheets | 0 |
| Animation delight | Pow `exact 1.0.6` (optional, MIT, pure Swift) | +1 (optional) |
| Email thread rendering | SwiftSoup (existing) + native SwiftUI `WebView`/`WebPage`; native collapse | 0 |
| Compose rich text | Native iOS 26 `TextEditor` + `AttributedString` + formatting definition | 0 |
| Depth/polish | Native Liquid Glass, `ConcentricRectangle`, `MeshGradient`, stacked shadows | 0 |
| Skeleton/shimmer | SwiftUI-Shimmer `exact 1.5.1` (already transitively pinned) + `.redacted` | +1 (zero marginal) |

Action item independent of this round: watch SwiftStreamingMarkdown releases — v0.6.0 still
revision-pins highlightswift/iosMath, forcing our branch pin; switch to a tagged pin the
moment upstream fixes it (Xcode Cloud reproducibility).

## refs/ screenshots

- `refs/apple-liquid-glass-landmarks.png` — Apple's Landmarks Liquid Glass sample (docs hero).
- `refs/apple-glass-union.png` — `glassEffectUnion` merged capsules (Apple docs).
- `refs/apple-concentric-rectangle.png` — ConcentricRectangle in the Notes format sheet (Apple docs).
- `refs/exyte-chat-demo.png` — ExyteChat README demo strip (evaluated, skipped).
- `refs/markdownui-overview.png` — MarkdownUI rendering sample (evaluated, skipped).
- `refs/pow-overview.png` — Pow effects overview card.
- `refs/richtextkit-demo.jpg` — RichTextKit editor demo (evaluated, skipped).
- `refs/shimmer-light.gif`, `refs/shimmer-dark.gif` — SwiftUI-Shimmer in both modes.
