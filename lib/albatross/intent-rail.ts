// Pure helpers for the intent rail in PlansSurface.
//
// Research (Albatross contract — research before code):
// - Mobbin/Things 3 Today (235f4304): dense rows, identity on the left, metadata
//   pushed right, full-row selection wash — no per-row icon soup.
// - Mobbin/Amie done divider (8651d9b8): status carried by one small colored
//   mark next to a typographic label, not by icon stacks.
// - MagicUI Dock (magicui.design/r/dock.json): collapsed tiles magnify with
//   macOS dock physics; a floating name label appears beside the hovered
//   tile (see components/ui/dock.tsx + lib/dock-magnify.ts).
//
// The collapsed rail renders each intent as a typographic initials dock tile
// plus one status-tone dot (one indicator per row). Expansion is EXPLICIT
// only — an "Expand list" control opens the labeled overlay, which stays
// open until its own collapse control is used (no hover expansion). These
// helpers stay DOM-free so bun:test covers them directly.

/** Collapsed rail width in px — one tile column plus gutters. */
export const RAIL_COLLAPSED_PX = 56;

/** Expanded overlay width in px — tile column plus a readable label column. */
export const RAIL_EXPANDED_PX = 288;

/**
 * Floating dock-label text for an intent tile: the display title, trimmed to
 * roughly `max` characters on a word boundary where one exists ("…" marks
 * the cut). Whitespace is collapsed so multi-line raw dumps read as one line.
 */
export function railTileLabel(title: string | null | undefined, max = 40): string {
  const clean = String(title ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (clean.length <= max) return clean;
  const slice = clean.slice(0, max);
  const lastSpace = slice.lastIndexOf(' ');
  const cut = lastSpace > max * 0.6 ? slice.slice(0, lastSpace) : slice;
  return `${cut.trimEnd()}…`;
}

/**
 * One/two-letter typographic initial for an intent title:
 * "Renew passport" -> "RP", "Taxes" -> "T". Leading punctuation is ignored
 * ("'quick' errand" -> "QE"); an empty title falls back to a middle dot.
 */
export function intentInitials(title: string | null | undefined): string {
  const words = String(title ?? '')
    .trim()
    .split(/\s+/)
    .map((word) => word.replace(/^[^\p{L}\p{N}]+/u, ''))
    .filter(Boolean);
  if (!words.length) return '·';
  const letterOf = (word: string) => Array.from(word)[0]?.toLocaleUpperCase() ?? '';
  const first = letterOf(words[0]);
  const second = words.length > 1 ? letterOf(words[1]) : '';
  return `${first}${second}` || '·';
}

/** Width spring for the explicit rail expand/collapse; instant under reduced motion. */
export function railExpandTransition(reduced: boolean) {
  if (reduced) return { duration: 0 };
  return { type: 'spring' as const, stiffness: 480, damping: 42 };
}

/**
 * Label reveal for expanded content: a short fade/slide with a slight delay so
 * labels trail the rail's width (≈150ms feel). Reduced motion: instant, no
 * slide. Used as `animate`/`transition` on label nodes of the expanded list.
 */
export function railLabelMotion(expanded: boolean, reduced: boolean) {
  return {
    animate: { opacity: expanded ? 1 : 0, x: expanded || reduced ? 0 : -6 },
    transition: reduced ? { duration: 0 } : { duration: 0.15, delay: expanded ? 0.05 : 0 },
  };
}
