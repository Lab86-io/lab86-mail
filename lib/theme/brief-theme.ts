'use client';

/* The shared artifact theme contract. AI-composed documents (the Daily Brief,
 * plan briefs) are theme-agnostic HTML built on --brief-* tokens with light
 * fallbacks; the host mirrors the app's resolved CSS variables into those
 * tokens over postMessage, so the artifact matches the app and restyles live
 * when the user changes fonts or colors. */

export const BRIEF_FONT_FAMILIES: Record<string, string> = {
  sans: "'Geist', system-ui, sans-serif",
  grotesk: "'Hanken Grotesk', system-ui, sans-serif",
  serif: "'Fraunces', Georgia, serif",
  instrument: "'Instrument Serif', Georgia, serif",
  news: "'Averia Serif Libre', Georgia, serif",
};

/** Pure token builder: `read` resolves an app CSS variable (may return ''). */
export function briefThemeTokens(
  read: (name: string) => string,
  appFont?: string | null,
): Record<string, string> {
  const v = (name: string) => read(name).trim();
  return {
    '--brief-bg': v('--color-bg') || '#faf9f6',
    '--brief-ink': v('--color-text') || '#1a1a1a',
    '--brief-muted': v('--color-text-muted') || '#6b6b6b',
    '--brief-hairline': v('--color-border') || '#e6e3dc',
    '--brief-accent': v('--color-accent') || '#c2683c',
    '--brief-accent-soft': v('--color-accent-soft') || 'rgba(194,104,60,0.14)',
    // Second accent: the editorial header/line voice (section titles, tags,
    // rules); accent-1 stays the action/emphasis voice. Fallback is a deep
    // ochre picked against the brief's paper, distinct from the terracotta.
    '--brief-accent-2': v('--color-accent-2') || '#774914',
    // Third accent: the highlight voice (badges, lanes, stat deltas).
    // Fallback is a slate blue against the warm paper.
    '--brief-accent-3': v('--color-accent-3') || '#305880',
    // Depth ladder rungs so artifact HTML can sit cards and wells on the same
    // elevation system as the host app.
    '--brief-card': v('--color-bg-elevated') || '#fefdfb',
    '--brief-well': v('--color-surface-well') || '#f1f0eb',
    '--brief-float': v('--color-surface-float') || '#fffffd',
    // Two fonts, like the rest of the app: the picked face drives the display
    // layer (headings/masthead); body copy stays sans.
    '--brief-font-display': BRIEF_FONT_FAMILIES[appFont ?? 'serif'] ?? BRIEF_FONT_FAMILIES.serif,
    '--brief-font-body': BRIEF_FONT_FAMILIES.sans,
    '--brief-display-tracking': appFont === 'instrument' ? '0.045em' : '0em',
  };
}

/** Read the app's live resolved theme (accent, background, light/dark). */
export function readBriefTheme(appFont?: string | null): Record<string, string> {
  if (typeof document === 'undefined') return briefThemeTokens(() => '', appFont);
  const css = getComputedStyle(document.documentElement);
  return briefThemeTokens((name) => css.getPropertyValue(name), appFont);
}

/** Post the current theme into an artifact iframe ('*': srcDoc is opaque-origin). */
export function postBriefTheme(win: Window | null | undefined, appFont?: string | null) {
  if (!win) return;
  win.postMessage({ source: 'lab86-host', type: 'theme', theme: readBriefTheme(appFont) }, '*');
}
