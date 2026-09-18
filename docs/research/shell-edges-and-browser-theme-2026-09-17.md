# Shell edges, browser chrome, and composer frame

## Observations and changes

Inspected the real AppShell/Rail/AssistantChat with the repository's synthetic browser fixture before editing. The desktop workspace added a 6px left gutter after a rail that already padded its icons. Collapsed icons therefore had an 8px left inset and 14px right inset; the expanded resize handle also sat 6px away from the workspace edge. The desktop panel now starts at the rail edge, giving collapsed icons equal 8px insets and centering the expanded drag handle on the panel edge. Top/right/bottom and all mobile gutters remain 6px.

The root theme-color metadata used pure black for dark mode even though the rail and app frame use a palette-derived green-tinted surface. The pre-hydration defaults now match the actual default frame: #19211c dark and #d2e0d6 light. BrowserThemeColor resolves the live `--color-workspace-frame` through CSS and writes an opaque sRGB hex value to a first-priority, media-free theme-color tag. Root theme/palette changes and navigation metadata replacements trigger a coalesced update; teardown removes the probe/tag and observers. An explicit app theme can differ from the OS theme. The server's media-qualified tags remain pre-hydration fallbacks.

Odyssey PromptInput drew a padded outer border and a second inner field border. It now has one border owner using Albatross's shared `rounded-ui` corner geometry. Existing input, attachments, Ask/Hold, keyboard submission and actions keep their ordering and behavior.

## Research

Browser-based product research used the actual Albatross fixture in Chromium at 1280px and 390px: expanded/collapsed rail, dragging, floating/split/full chat and light/dark palettes. Before/after screenshots and measured element bounds verified the specific spacing defect instead of introducing a new layout.

Consulted primary documentation for [theme-color metadata](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/meta/name/theme-color) and [manifest theme_color](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/Reference/theme_color). The application uses page metadata; no web app manifest exists in this repository. Actual native Dia browser chrome cannot be exercised by the Linux Chromium runner; the checks verify the exact color supplied to browser chrome matches the rendered frame.

Applied the Mobbin research skill; its search tools remain unavailable in this session. Existing composer research in `docs/research/odyssey-ai-chat-2026-09-17.md` references [Tana](https://mobbin.com/screens/572a2ee5-025a-4fcc-89a4-3b6fb354df19), [Higgsfield](https://mobbin.com/screens/b3d37b95-b6a7-4d0b-a069-4239a27452f1), and [Mistral Le Chat](https://mobbin.com/screens/edacf670-c966-421c-85ec-ad218e18a549). No fresh Mobbin results are claimed. This correction preserves the existing composition and custom corners.

## Validation

- Four new DOM tests cover live app-mode/palette color updates, precedence after navigation metadata changes, observer stability/cleanup, and missing canvas/style fallback. Existing Odyssey keyboard/IME and chat behavior tests pass.
- `scripts/verify-shell-edges-ui.mjs` verifies desktop expanded/collapsed/drag alignment, symmetric icon insets, mobile gutters, one composer frame with shared corner geometry, retained drafts through chat layouts, explicit app mode versus OS mode, palette edits, system light/dark changes, no horizontal overflow and no browser exceptions. Screenshots inspected.
- Full suite: 4,110 pass, one optional skip. Typecheck and lint pass with existing lint notices only.
