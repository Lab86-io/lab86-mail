# Albatross corner system

Latest September 11 instruction: undo one more version, removing the curved
tops. Active geometry is now fixed 14px with `superellipse(1.475)` for all shared
UI surfaces; round fallback remains 9.5px. The history below is superseded.

Superseded by the user's September 11 rollback request: restore the version
immediately before the Browserbase/Mobbin delegation. Active geometry is
`superellipse(1.65)` with `--radius-ui: 50% / min(50%, 14px)` and one shared
radius for controls, composer, launcher, panels and overlays. The round fallback
is 9.5px. The subagent radius ladder below is retained as historical research,
not the current implementation. Decorative frame work from the other session
is preserved. Browser verification: `/tmp/albatross-corner-system-M87NTY`.

Date: 2026-09-10. Web only. Supersedes the radius table in
[soft-square-corners.md](soft-square-corners.md). No native, contract, or data changes.

## Decision

One continuous curve, `corner-shape: superellipse(1.6)`, and a fixed-pixel radius ladder
by role. Radii never use percentages. The rejected 50% treatment bowed long edges
into capsules and made the small Send control excessively rounded.

| Role | Token | Supported | Round fallback | Tailwind aliases |
| --- | --- | --- | --- | --- |
| Detail: keys, inline code, tiny chips | `--radius-detail` | 5px | 3px | none |
| Control: buttons, fields, sidebar rows, menu items, compact suggestions, Send | `--radius-control`, `--radius-ui`, `--radius-ui-corner` | 10px | 6px | `rounded`, `rounded-ui`, `rounded-xs`, `rounded-sm`, `rounded-md`, `rounded-lg` |
| Card: composer, launcher, larger suggestions, popovers | `--radius-card`, `--radius-launcher` | 14px | 9px | `rounded-xl`, `rounded-2xl` |
| Overlay: dialogs, command palette | `--radius-overlay` | 16px | 10px | none |
| Panel: workspace frame, assistant panel, brief art frame | `--radius-panel` | 20px | 12px | `rounded-3xl`, `rounded-4xl` |

The `@supports (corner-shape: superellipse(1.6))` block in `app/globals.css` switches the
curve and the five radii together. `--workspace-gutter` stays 6px. Colors, type, and
spacing are unchanged.

Final local-review adjustment: the user requested one tiny step softer after
reviewing both agent versions. Only the curve changed from 1.7 to 1.6; the fixed
radius ladder stayed unchanged. To undo this adjustment, restore 1.7 in the
`@supports` check and `--corner-shape-ui` value, and update the three browser
check expectations. The original research and fit comparison remain below.
Decorative picture-frame mouldings are being developed in another session;
their artwork and geometry are preserved separately from these UI tokens.

## Why this curve

The Figma article on corner smoothing describes a bounded corner: two Bezier tails, a
short circular arc, and a smoothing parameter. Figma states that 60% smoothing matches
the iOS continuous corner. The `figma-squircle` package implements that article, and its
`getPathParamsForCorner` gives the exact path for a given radius and smoothing.

I fitted the CSS superellipse against that path with a numeric Hausdorff distance:

| Candidate | Max deviation per 10px radius |
| --- | --- |
| `superellipse(1.7)` at 1.6x radius | 0.33px |
| `superellipse(1.6)` at 1.6x radius | 0.34px |
| `superellipse(2)` (the `squircle` keyword) at 1.6x radius | 0.58px |
| `round` at 1.0x radius | 6.0px |

The Figma extent is `(1 + smoothing) * R`, so 60% smoothing spreads the corner over 1.6
times the nominal radius. The supported radii are approximately 1.6 times the fallback
radii, rounded to whole pixels to preserve similar visual size across branches. The proof page at
`/tmp/albatross-corner-claude/proof.png` draws the Figma path in red over each CSS shape
at the real control sizes.

## Why these sizes

Mobbin web screens of Linear settings and Notion AI chat show the same pattern: sidebar
highlights and fields are mostly square, with a visual radius near one fifth of the row
height, and cards or composers step up one size. The 10px control radius (visual 6px on a
32px row) and the 14px card radius (visual 9px) follow that ratio.

- [Linear settings, sidebar highlight](https://mobbin.com/screens/fea37c46-ab06-4d46-86c7-333ffb0db455)
- [Linear customize sidebar dialog](https://mobbin.com/screens/f81c0f0b-aaf3-45a0-9985-d79c9b0c0cca)
- [Notion AI chat composer](https://mobbin.com/screens/fbc30f35-7e02-43fb-875d-f1a4b8eba372)
- [Notion page with cover and sidebar](https://mobbin.com/screens/f2dcf700-2fe5-4633-a706-e0391c025432)

Nested surfaces keep a smaller radius inside a larger one: card 14px inside panel 20px,
control 10px inside card 14px. Send uses the control role at 32px, so it is a soft square.

## Sources and limitations

Primary sources read in this session:

- [CSS Borders Level 4, corner shaping and rendering](https://drafts.csswg.org/css-borders-4/#corner-shaping).
  Defines `superellipse(K)` with exponent `2^K` inside the box set by `border-radius`.
- [MDN: corner-shape](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/corner-shape).
  Borders, outlines, shadows, and overflow clipping follow the shape.
- [figma-squircle source](https://github.com/tienphaw/figma-squircle), which implements
  [Figma: Desperately seeking squircles](https://www.figma.com/blog/desperately-seeking-squircles/).

Browserbase is not exposed in the Claude session. The coordinating agent supplied
`/tmp/albatross-corner-browserbase-supplement.md` from its own Browserbase session on
2026-09-10. It read the Figma article and MDN and reported the same bounded-corner model.
Its Chrome developer blog extraction was empty, and WebFetch of that page returned 404,
so no claim rests on that page.

The [MDN compatibility data](https://github.com/mdn/browser-compat-data/blob/main/css/properties/corner-shape.json)
reports Chromium 139+, Safari preview, and no Firefox support at review time.
The fallback branch was checked in Chromium by reading the computed styles,
not in Safari or Firefox. The selected 1.6 parameter closely fits the Figma
profile, not a claim of exact Apple geometry.

## Implementation notes

- The Tailwind `@utility rounded-*` needs a `--value(--radius-*, [*])` declaration.
  With only `corner-shape`, Tailwind drops the utility and `rounded-xl` or
  `rounded-[10px]` never receive the curve. Offline compilation with
  `@tailwindcss/node` confirmed every variant now emits, and `rounded-full` keeps
  `corner-shape: round` as the last rule.
- The directional utilities `rounded-t-ui`, `rounded-b-ui`, `rounded-l-ui`, and
  `rounded-r-ui` use `--radius-ui-corner`, an alias of the control radius. Joined controls
  keep a square internal seam.
- The composer frame in `components/shell/AskHoldComposer.tsx` moved from `rounded-ui`
  to `rounded-2xl`, the card role. The base `PromptInput` still defaults to the control
  role for compact uses.

## Verification

`node scripts/verify-corner-system-ui.mjs` runs against the local dev server
(`CORNER_ORIGIN` overrides the origin). It checks the workspace panel and art frame at
390, 1046, and 1440px, the search and selected sidebar row, the Send square and composer
in light and dark, and eight compiled utility classes. It passed on 2026-09-10 with
screenshots in `/tmp/albatross-corner-system-wQHzkk`. The live tokens were also read from
the dev server: panel 20px, search 10px, selected row 10px, launcher 14px.

After the user's small softening request, actual-app corner checks passed again
at `/tmp/albatross-corner-system-FPqOgd`, with `superellipse(1.6)` and the same
radius ladder. Controls, field focus, menus, dialog focus return, avatars and
the simulated round fallback passed at `/tmp/albatross-controls-ui-3rq6ZI`.
The temporary control fixture used port 18849 to avoid another session's 18840.
