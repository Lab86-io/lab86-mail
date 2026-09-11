# Soft-square corners

Superseded on 2026-09-10 by
[albatross-corner-system-2026-09-10.md](albatross-corner-system-2026-09-10.md), which
changes the radius table and uses `superellipse(1.6)` after the final softening review.

Date: 2026-09-09. Web-only iteration; no native changes. Staging release requested
after local acceptance; no production deployment authorized.

## Direction and evidence

The request is a custom corner, not simply another `border-radius` number.
Use a quiet **soft-square**: `superellipse(1.6)`, between an ordinary circle and
the standard squircle. Give it more room to approach each straight edge, while
keeping the existing control sizes, density, colors, and depth system. The
assistant launcher should read as a floating control, not a pill.

Reviewed the actual signed-in staging Files/rail/launcher in the shared browser,
plus the previous control-system screenshots and surrounding component code.
No account data or settings changed. Mobbin tool discovery remains unavailable;
no Mobbin findings are claimed. Carry this note into the eventual PR alongside
the [control-system review](control-system-and-files-next.md).

Primary references:

- [MDN: corner-shape](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/corner-shape)
  explains how borders, shadows, outlines, and clipping follow the actual corner.
- [MDN: superellipse](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Values/superellipse)
  defines the parameter: 1 is round, 2 is squircle. The intermediate 1.6 choice
  is our visual judgment, not a claim of exact Apple/Figma geometry.
- [MDN compatibility data](https://github.com/mdn/browser-compat-data/blob/main/css/properties/corner-shape.json)
  reports Chromium 139+, no Firefox support, and Safari preview only at review
  time. This is progressive enhancement, not universal web/native parity.

## Implementation contract

| Role | Rounded fallback | Supported soft-square |
| --- | --- | --- |
| Controls, fields, compact menus | 9px | 13px |
| Floating assistant launcher | 14px | 20px |
| Shared cards | 24px | 34px |
| Dialogs, global search overlay | 18px | 26px |

The radius measures where the curve begins; a superellipse is squarer at the
same radius, so a longer radius preserves roughly similar perceived softness.
An `@supports` block switches both curve and radii together. No element sizing,
positioning, focus behavior, or event handling changes in the app.

Opt in via `.corner-smooth` on shared primitives; `.control-field`, rail
selection, and the profile **trigger** use the same shape token. Do not apply
the shape to every div or every element with rounded corners. Profile images,
status dots, document content, and intentional `rounded-full` controls remain
round. Square and custom radius overrides continue to work. Utilities or inline
styles can override the shape for a bespoke surface.

No SVG masks, clipping wrappers, ResizeObservers, dependency, or runtime feature
detection: those add complexity and can clip outlines/shadows or distort corners
when a button's width changes. Unsupported browsers keep regular round corners
and full functionality. Native continuous corners remain the native owner's
scope; these web styles do not change SwiftUI.

## Reproducible acceptance

Build, then run `bun scripts/preview-narrative-tools.mjs --controls`.
`http://127.0.0.1:18840/?corners=compare` adds an enlarged side-by-side curve
comparison using the actual tokens, plus intentional circle/square overrides.
This is a synthetic fixture, not a public app route.

Run `scripts/verify-controls-ui.mjs` with the local Playwright Chromium binary.
It checks light/dark at 390/768/1440px, real computed curve/radius values, no
clip-path/mask, matched field surfaces, focus, menus, dialog editing and Escape
focus return, collapsed rail geometry, avatar circles, and round/square overrides.
It also removes the actual enhancement `@supports` rule through CSSOM and checks
the rounded fallback at phone/desktop widths. That is a fallback simulation in
Chromium, **not** a Safari or Firefox acceptance run. Files browser acceptance
and the full existing suite should also remain green.

### Results

- Full suite: 3,389 passed, zero failed (337 files); production build and its
  TypeScript phase passed. Repository lint also passed.
- Controls acceptance passed: `/tmp/albatross-controls-ui-f6j1kw`; includes
  comparison, light/dark layouts, settled dialog, collapsed rail, and fallback
  screenshots. Files acceptance passed: `/tmp/albatross-files-ui-agMbM5`.
- Reviewed desktop comparison/full controls and phone dark/dialog screenshots.
  Kept the curve subtle and the avatar circular; no clipping wrapper was needed.
- Shared browser inspected the signed-in staging before-state but could not
  navigate to the local preview, including its environment-port target. Changed
  code was verified with local Playwright; do not call this signed-in deployed
  acceptance. Staging/production were unchanged at this local acceptance gate.
