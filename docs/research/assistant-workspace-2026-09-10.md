# Assistant workspace: review follow-up (2026-09-10)

Scope: the corner/split/full frame (`components/shell/AssistantWorkspace.tsx`), the floating launcher
(`components/shell/ShellActions.tsx`), their stylesheet, their tests, the synthetic preview and the browser
acceptance script. No native, Files, shared-state, AppShell or AIBar edits. Root owns the actual-shell
acceptance on port 18847; this note covers the frame's own acceptance on the synthetic preview (port 18845).

## Findings addressed

1. **Resize math and CSS disagreed.** `clampPageShare` works in percent of the width left after the 6px seam,
   but the split's `grid-template-columns` applied that percent to the full frame width, so both ends of the
   range ran 6px past the frame (the frame clips, so `document.scrollWidth` could not see it). The share is
   now a unitless number and the track is `calc((100% - seam) * share / 100)`; the clamp and the track use
   the same width. Measured in Chromium after the change:

   | Frame width | Key | Page | Seam | Chat | Inside frame |
   | --- | --- | --- | --- | --- | --- |
   | 646 | default, Home, End | 280 | 6 | 360 | yes |
   | 1384 (1440 viewport) | default | 689 | 6 | 689 | yes |
   | 1384 | Home | 280 | 6 | 1098 | yes |
   | 1384 | End | 1018 | 6 | 360 | yes |

   The acceptance script now reads the child boxes against the frame's own box (`panesInside`) at 646,
   1024 and 1440, for the default split, both pointer floors, Home, End and the arrow keys.

2. **Eyebrow label.** The launcher eyebrow is sentence case ("Ask Albatross") at `letter-spacing: normal`.
   Root's screenshot with "ASK ALBATROSS" predates the stylesheet change by eight minutes and will refresh on
   the next rebuild. The micro-label guard in `tests/albatross-shell-vocabulary.test.ts` now also scans every
   stylesheet under `components/` and `app/` for an upper-case transform paired with em tracking in the same
   rule block, so the CSS path cannot be used to bring the pattern back.

3. **Spotlight, not card.** The panel's 86% fill sat on top of a halo whose wash peaked at 62% directly
   under the panel, so the corner was about 95% covered and read as an opaque card. Now the halo carries most
   of the softening and the panel is a lens over it:

   | | Light | Dark |
   | --- | --- | --- |
   | Panel fill over blur | 46% of `--color-bg-elevated` | 54% |
   | Panel blur | 28px, saturate 1.2 | same |
   | Halo wash at the corner, fading to 0 by 72% | 34% of `--color-bg` | 40% |
   | Halo blur | 10px | same |
   | Edge | 1px border at 78% + 1px inner highlight at 62% white | 70% + 9% white |
   | Shadow | wide and soft, not `--shadow-pop` | same, darker |

   Readability trade-off: the 28px blur removes the high-frequency detail that would fight text, and the
   tint keeps body text on a smooth field; muted text over a very busy or saturated page will sit closer to
   its contrast floor than it did on the 86% card. That is the requested feel, and the fill is kept at or
   above 40% (asserted from computed style) rather than going fully clear. No page scrim, no glow, no
   sparkle. Reduced transparency, more contrast and forced colors still get an opaque `--color-bg-elevated`
   panel with no blur and no halo (asserted: alpha 1, `backdrop-filter: none`, halo `display: none`).
   Motion: the panel scales from 0.97 at the bottom-right corner over 300ms; reduced motion disables it.

4. **Focus and Escape acceptance** now covers, in the browser, at 1440 and 1024: Escape inside the history
   menu closes only the menu and leaves the chat open with focus inside it; a following Escape in the
   composer closes the chat and lands focus on the launcher; the shortcut while focus is on the page filter
   closes the chat and leaves focus on the filter; the chat's Close button returns focus to the opener (the
   filter) when the chat was opened from the page, and to the freshly mounted launcher when it was opened
   from the launcher. Chat mount count stays 1 throughout.

   Two real defects found while finishing this:
   - A drag whose seam disappeared mid-drag (split collapsing to full, or the chat closing) never ran its
     cleanup, leaving `data-resizing="true"` and both panes `pointer-events: none`. The drag is now tracked
     in a ref and ended by the layout change or unmount; the late pointer-up is ignored. Covered in jsdom and
     in the browser ("drag interrupted").
   - Ending a drag removed the inline share variable, and React does not rewrite a style value it believes
     unchanged, so a press that ended where it started snapped the split back to the stylesheet's 50 while
     `aria-valuenow` still said 60. The cleanup now leaves the inline value at what the next render holds.
   - `onDoubleClick` on the seam never fired because `preventDefault` on pointerdown suppresses the
     synthesised `dblclick`. Reset is now two presses within 400ms and 6px, handled in pointerdown, with the
     seam title updated. Covered in jsdom and via Playwright's `dblclick`.

   Child autofocus: the frame moves focus to the chat section in a layout effect only when focus is not
   already inside; AIBar's own composer focus runs later and wins. A focus request that arrives after the
   chat has gone inert is a no-op by the platform.

5. **Test dependencies and globals.** `jsdom@25.0.1` is a direct devDependency (the version already in the
   lockfile via `@odoo/owl`, so no second copy). `@types/jsdom` is not added: `tests/` is excluded from
   `tsconfig.json`, bun's runner does not typecheck, and the available `@types/jsdom` majors (21, 27, 28,
   30) do not match 25. The test file now saves every global it touches by its real key as a property
   descriptor and restores or deletes each one in `afterAll`, asserting that `IS_REACT_ACT_ENVIRONMENT`
   and `ResizeObserver` end up exactly as they began.

## Evidence

- `bun test tests/assistant-workspace.test.tsx tests/albatross-shell-vocabulary.test.ts tests/assistant-launcher.test.ts`: 49 pass, 0 fail.
- `bun scripts/verify-assistant-workspace-ui.mjs` (preview on 18845, Chromium via playwright-core): all
  steps pass at 1440, 1024, 646, 640 and 390; zero page errors. Screenshots:
  `/tmp/albatross-assistant-workspace-0st2Ia/` (`split-646.png`, `corner-1440-{light,dark}.png`,
  `corner-contrast-1440.png`, `launcher-1440-light.png` and the rest of the matrix).
- `biome check` on the owned files: clean.
- Not verified here: root's actual AppShell/AIBar run on 18847 and its screenshots, which will need a rerun to
  pick up the stylesheet and frame changes.

## Research note

Mobbin remained unavailable in this session. The reference is the user's iOS 17 Messages "+" menu
screenshot and Apple's own behaviour of that surface (a translucent material over the blurred conversation,
grown from the control, with the page kept legible), plus MDN for `backdrop-filter`, `inert`,
`prefers-reduced-transparency` and `prefers-contrast`.
