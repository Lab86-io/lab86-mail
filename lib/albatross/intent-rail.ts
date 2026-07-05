// Pure helpers for the intent hover rail in PlansSurface.
//
// Research (Albatross contract — research before code):
// - Mobbin/Things 3 Today (235f4304): dense rows, identity on the left, metadata
//   pushed right, full-row selection wash — no per-row icon soup.
// - Mobbin/Amie done divider (8651d9b8): status carried by one small colored
//   mark next to a typographic label, not by icon stacks.
// - Collapsible icon rails (Linear/Slack pattern): collapsed shows identity
//   glyphs only; hover expands in place as an overlay so content keeps width.
//
// The rail renders each intent as a typographic initials tile plus one
// status-tone dot (one indicator per row). These helpers stay DOM-free so
// bun:test covers them directly.

/** Collapsed rail width in px — one tile column plus gutters. */
export const RAIL_COLLAPSED_PX = 56;

/** Expanded overlay width in px — tile column plus a readable label column. */
export const RAIL_EXPANDED_PX = 288;

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

/** Width spring for the rail expand/collapse; instant under reduced motion. */
export function railExpandTransition(reduced: boolean) {
  if (reduced) return { duration: 0 };
  return { type: 'spring' as const, stiffness: 480, damping: 42 };
}

/**
 * Label reveal for expanded content: a short fade/slide with a slight delay so
 * labels trail the rail's width (≈150ms feel). Reduced motion: instant, no
 * slide. Used as `animate`/`transition` on always-mounted label nodes.
 */
export function railLabelMotion(expanded: boolean, reduced: boolean) {
  return {
    animate: { opacity: expanded ? 1 : 0, x: expanded || reduced ? 0 : -6 },
    transition: reduced ? { duration: 0 } : { duration: 0.15, delay: expanded ? 0.05 : 0 },
  };
}
