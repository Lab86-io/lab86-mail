const PREVIEW_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return entities[character];
  });
}

/** HTML fragments are authored in the repo and displayed in an opaque, script-free iframe. */
export function buildUpdatePreview(html: string, title: string, appearance?: 'light' | 'dark'): string {
  const darkPalette =
    '--surface:#151a18;--text:#edf2ee;--muted:#a4afa8;--border:#303b34;--accent:#9cceb0;--soft:#23382b';
  return `<!doctype html><html lang="en" data-theme="${appearance ?? 'system'}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><style>
    :root{color-scheme:light dark;--surface:#fff;--text:#17202a;--muted:#5d6b7a;--border:#dce4ee;--accent:#0f5132;--soft:#e5f2eb}
    :root[data-theme=dark]{${darkPalette}}
    @media(prefers-color-scheme:dark){:root[data-theme=system]{${darkPalette}}}
    *{box-sizing:border-box}html,body{margin:0;background:transparent;color:var(--text);font-family:system-ui,sans-serif}body{padding:16px}img{max-width:100%}a{color:inherit}
  </style></head><body>${html}</body></html>`;
}
