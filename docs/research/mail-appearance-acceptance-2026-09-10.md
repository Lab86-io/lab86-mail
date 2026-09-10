# Mail foundations and inline Appearance acceptance

This round uses the actual `InboxThreadRow`, `InboxDateGroup`, `Avatar`,
`AccountScopePopover`, and `ThemePanel` components with synthetic local data.
It does not authenticate, query account APIs, or read real mail. The browser
evidence is component acceptance, not a claim of signed-in or native acceptance.

## Reproduce

Run `bun scripts/preview-mail-foundations.mjs` after at least one successful
Next build (the preview reuses real font assets). The preview compiles the
current global styles directly with PostCSS/Tailwind; it does not depend on
stale application CSS. It listens only on `127.0.0.1:18844`.

- Mail: `http://127.0.0.1:18844/`
- Appearance: `http://127.0.0.1:18844/?view=appearance`
- `bun scripts/verify-mail-foundations-ui.mjs`
- `bun scripts/verify-appearance-settings-ui.mjs`

Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` if Chromium is not installed at
Playwright's default path. Each verifier prints an artifact directory containing
screenshots and a machine-readable `evidence.json` report.

## Verified

Both surfaces passed at 390, 768, and 1440 CSS pixels in light and dark modes.

Mail checks:

- Loaded photos, initials, failed-image fallbacks, and recovered photos.
- One 28px circular ring owner; image/initials/ring centers match exactly.
- Separate centered hit target; no duplicate inset or outer avatar shadows.
- Opaque 1px row and date-group dividers with visible surface separation.
- Decoded entities render as text, including hostile markup that never executes.
- Arrow navigation, Enter to open, and Space to select/unselect.
- Mailbox popover opens without activating its containing row and restores
  keyboard focus after Escape.
- Mailbox filtering cannot deselect the final account; All accounts resets it.
- Search filtering, no horizontal overflow, actual display-font loading, no
  uncaught page errors, and zero account-API calls.

Appearance checks:

- Mounting the inline settings leaves existing persisted choices untouched.
- Existing palette, typeface, grain, size, and depth apply to the document.
- Mode and font selection expose their selected state to assistive technology.
- Palette wheel supports keyboard changes without changing unrelated settings.
- Font edits preserve the remaining appearance settings and unrelated state.
- Leaving/reopening the section and a full page reload preserve the same choices.
- No horizontal overflow or account-API calls.

Focused source/state tests also guard the rail footer order
Settings → Notifications → Profile, removal of Theme/account filtering from that
footer, reuse of the existing settings theme owner, and preference persistence.

## Findings returned to implementation

The acceptance pass found missing accessible names on sender mailbox actions and
missing selected-state semantics on Appearance controls. Both were corrected and
the browser checks reran successfully.

An additional visual review flagged small, faint section labels/readouts inherited
from the previous compact theme popover. These were increased to 12px and given
stronger semantic text colors. The final browser verifier now measures headings,
slider labels, and readouts against their actual opaque surface and requires at
least 4.5:1 contrast. The seeded custom palette measured a minimum of 5.38:1 in
light mode and 5.44:1 in dark mode across all three widths. This checks one custom
palette and the audited controls, not every possible theme combination.

The visual review used the Apple-interface review checklist for hierarchy,
controls, accessibility, and light/dark adaptation. It did not infer native Apple
acceptance from these web screenshots.
