// Content-Security-Policy for the Daily Brief frames (CASA finding S5).
//
// A brief frame shows HTML that a model wrote from mailbox data. The frame is
// sandboxed without allow-same-origin, but a prompt-injected brief could still
// send brief text to another host with fetch, a WebSocket, a beacon, an image
// URL, a style sheet, or a form. The host puts this policy in a meta element at
// the start of each frame document, before any model-written element:
//
// - connect-src 'none': no fetch, XMLHttpRequest, WebSocket, EventSource, or beacon.
// - img-src: data: and blob: URLs, the app origin (local art fallbacks, frames),
//   the Convex storage origin (area images), and the museum image hosts of the
//   daily art pool. No other image host.
// - style-src and font-src: inline styles and Google Fonts only.
// - script-src 'unsafe-inline': the host runtime and the edition scripts are
//   inline. The page policy that the frame inherits still asks for the page
//   nonce (lib/security/frame-nonce.ts); the two policies apply together.
// - form-action 'none', base-uri 'none', object-src 'none', default-src 'none'.
//
// A nested srcdoc frame (a custom widget) inherits this policy.

/** Image hosts of the daily art pool (lib/mail/daily-art-pool.ts). */
export const BRIEF_ART_IMAGE_ORIGINS = [
  'https://images.metmuseum.org',
  'https://openaccess-cdn.clevelandart.org',
  'https://api.smk.dk',
  'https://iip.smk.dk',
  'https://api.nga.gov',
  // Earlier editions show Art Institute of Chicago images.
  'https://www.artic.edu',
] as const;

export const BRIEF_FONT_STYLE_ORIGIN = 'https://fonts.googleapis.com';
export const BRIEF_FONT_FILE_ORIGIN = 'https://fonts.gstatic.com';

export const BRIEF_FRAME_CSP_META_ID = 'lab86-brief-csp';

export interface BriefFrameCspOptions {
  /** The origin of the app page that holds the frame. */
  appOrigin?: string | null;
  /** The Convex deployment URL; area images live in its file storage. */
  storageUrl?: string | null;
}

/** The origin of an http(s) URL, or null. */
export function httpOrigin(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
  } catch {
    return null;
  }
}

export function briefFrameContentSecurityPolicy(options: BriefFrameCspOptions = {}): string {
  const imageSources = [
    'data:',
    'blob:',
    httpOrigin(options.appOrigin),
    httpOrigin(options.storageUrl),
    ...BRIEF_ART_IMAGE_ORIGINS,
  ].filter((source): source is string => Boolean(source));
  const directives: Array<[string, string[]]> = [
    ['default-src', ["'none'"]],
    ['script-src', ["'unsafe-inline'"]],
    ['style-src', ["'unsafe-inline'", BRIEF_FONT_STYLE_ORIGIN]],
    ['font-src', [BRIEF_FONT_FILE_ORIGIN]],
    ['img-src', [...new Set(imageSources)]],
    ['connect-src', ["'none'"]],
    ['object-src', ["'none'"]],
    ['base-uri', ["'none'"]],
    ['form-action', ["'none'"]],
  ];
  return directives.map(([name, sources]) => `${name} ${sources.join(' ')}`).join('; ');
}

const EXISTING_META = new RegExp(
  `<meta\\b(?=[^>]*\\bid\\s*=\\s*(["'])${BRIEF_FRAME_CSP_META_ID}\\1)[^>]*>`,
  'gi',
);
// A doctype must stay the first token, or the frame drops to quirks mode. A
// byte order mark, white space, and comments can come before it.
const LEADING_DOCTYPE = /^\uFEFF?\s*(?:<!--[\s\S]*?-->\s*)*<!doctype\b[^>]*>/i;

/**
 * Puts the brief frame policy in a meta element before all other content of
 * the document. The parser then places the meta element in <head>, and the
 * policy covers every element after it. A second call replaces the element.
 */
export function withBriefFrameCsp(html: string, options: BriefFrameCspOptions = {}): string {
  if (!html) return html;
  const meta = `<meta http-equiv="Content-Security-Policy" id="${BRIEF_FRAME_CSP_META_ID}" content="${briefFrameContentSecurityPolicy(options)}">`;
  const next = html.replace(EXISTING_META, '');
  const doctype = LEADING_DOCTYPE.exec(next);
  const at = doctype ? doctype[0].length : 0;
  return `${next.slice(0, at)}${meta}${next.slice(at)}`;
}
