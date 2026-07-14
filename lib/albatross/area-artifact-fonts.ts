// Typography is host-owned even though the Area document is model-composed.
// Keep this boundary deterministic so every edition — including artifacts
// generated before a font preference changed — loads and uses the app faces.

export const AREA_ARTIFACT_FONT_STYLESHEET =
  'https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400..700;1,9..144,400..600&family=Instrument+Serif:ital@0;1&family=Averia+Serif+Libre:wght@400;700&family=Geist:wght@400..700&family=Hanken+Grotesk:wght@400..700&display=swap';

export const AREA_ARTIFACT_FONT_CONTRACT = `<link id="lab86-area-fonts" rel="stylesheet" href="${AREA_ARTIFACT_FONT_STYLESHEET}">
<style id="lab86-area-font-contract">
body,body *{font-family:var(--brief-font-body,'Geist',system-ui,sans-serif)!important}
body :is(h1,h2,h3,h4,h5,h6,[data-brief-display]),body :is(h1,h2,h3,h4,h5,h6,[data-brief-display]) *{font-family:var(--brief-font-display,'Fraunces',Georgia,serif)!important;letter-spacing:var(--brief-display-tracking,0em)!important}
body :is(code,pre,kbd,samp),body :is(code,pre,kbd,samp) *{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace!important}
</style>`;

/** Idempotently install the host typography contract in a complete document. */
export function injectAreaArtifactFontContract(html: string) {
  if (!html) return html;
  const next = html
    .replace(/<link\b(?=[^>]*\bid=(["'])lab86-area-fonts\1)[^>]*>/gi, '')
    .replace(/<style\b(?=[^>]*\bid=(["'])lab86-area-font-contract\1)[^>]*>[\s\S]*?<\/style>/gi, '');
  const head = /<head\b[^>]*>/i.exec(next);
  if (head) {
    const at = (head.index ?? 0) + head[0].length;
    return `${next.slice(0, at)}${AREA_ARTIFACT_FONT_CONTRACT}${next.slice(at)}`;
  }
  return next.replace(/<html([^>]*)>/i, `<html$1><head>${AREA_ARTIFACT_FONT_CONTRACT}</head>`);
}
