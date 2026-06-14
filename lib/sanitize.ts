'use client';

// Browser-only DOMPurify wrappers. Server-side these return empty — the
// caller should only use the sanitized HTML after mount to avoid SSR/client
// divergence.

let cachedRead: ((html: string) => string) | null = null;
let cachedFrame: ((html: string) => string) | null = null;
let cachedSend: ((html: string) => string) | null = null;

function getDOMPurify(): any {
  // Lazy require so SSR never touches the package.
  const DOMPurify: any = (require('dompurify') as any).default ?? require('dompurify');
  return DOMPurify(window);
}

export function sanitizeEmailHtml(html: string): string {
  if (typeof window === 'undefined') return '';
  if (!cachedRead) {
    const instance = getDOMPurify();
    cachedRead = (input: string) =>
      instance.sanitize(input, {
        FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta'],
        FORBID_ATTR: ['onerror', 'onclick', 'onload', 'onmouseover'],
        // Raster image data: URIs only — keeps inline signature images working
        // while excluding svg+xml and other embeddable documents.
        ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|tel:|data:image\/(?:png|jpe?g|gif|webp|bmp);base64,)/i,
      }) as string;
  }
  return cachedRead(html);
}

// Sanitizer for HTML rendered inside the isolated email iframe. Unlike the
// inline read path, it KEEPS <style> blocks — marketing emails define their
// text colors and layout there, and stripping it leaves text uncolored
// (inheriting a stray inline white onto a white card = invisible). The iframe
// is a no-scripts sandbox, so the style is scoped and can't touch the app;
// scripts/objects/external documents are still removed as defense in depth.
export function sanitizeEmailFrameHtml(html: string): string {
  if (typeof window === 'undefined') return '';
  if (!cachedFrame) {
    const instance = getDOMPurify();
    cachedFrame = (input: string) =>
      instance.sanitize(input, {
        WHOLE_DOCUMENT: true,
        FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'link', 'meta', 'base'],
        FORBID_ATTR: ['onerror', 'onclick', 'onload', 'onmouseover'],
        ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|tel:|data:image\/(?:png|jpe?g|gif|webp|bmp);base64,)/i,
      }) as string;
  }
  return cachedFrame(html);
}

// Does this email ship its own (opaque) background? Branded HTML mail paints
// white/colored cards via bgcolor= or inline background[-color]; plain-text
// and lightly-marked-up replies declare none and just inherit. We use this to
// decide dark-mode treatment: emails with their own background render on a
// light "paper island" (their colors stay correct); backgroundless emails
// adapt to dark mode (dark surface, light text) so a one-line reply isn't a
// jarring white slab. Cheap string scan over the already-sanitized HTML.
const BG_NON_COLOR = new Set(['transparent', 'none', 'inherit', 'initial', 'unset', 'currentcolor', '']);

export function emailDeclaresOwnBackground(html: string): boolean {
  // Classic table emails use the bgcolor attribute.
  if (/\sbgcolor\s*=\s*["']?\s*#?[0-9a-z(]/i.test(html)) return true;
  // Inline background / background-color with a real value (color or image).
  const re = /background(?:-color)?\s*:\s*([^;"']+)/gi;
  let match: RegExpExecArray | null = re.exec(html);
  while (match) {
    const value = match[1].trim().toLowerCase();
    if (!BG_NON_COLOR.has(value)) return true;
    match = re.exec(html);
  }
  return false;
}

// Anything resembling a full HTML email document should keep its native CSS
// and table layout. The inline renderer is only for simple fragments/replies.
export function emailNeedsIsolatedFrame(html: string): boolean {
  if (emailDeclaresOwnBackground(html)) return true;
  if (/<(?:!doctype|html|head|body|style|table|tbody|thead|tfoot|tr|td|th|colgroup|meta)\b/i.test(html))
    return true;
  if (/<!--\s*\[if\s*(?:mso|gte\s+mso|lt\s+mso|ie)\b/i.test(html)) return true;
  if (/@media\b|@font-face\b|mso-|xmlns:|class=["'][^"']{20,}/i.test(html)) return true;
  return false;
}

// Sanitizer for HTML the user *sends* (i.e. their own composed content,
// converted from markdown). Slightly broader allowlist than the read path —
// e.g. we keep <pre>, <code>, blockquote styling, simple inline styles for
// emphasis. Still strips scripts and event handlers as a basic safety net.
export function sanitizeOutgoingHtml(html: string): string {
  if (typeof window === 'undefined') return '';
  if (!cachedSend) {
    const instance = getDOMPurify();
    cachedSend = (input: string) =>
      instance.sanitize(input, {
        ALLOWED_TAGS: [
          'a',
          'abbr',
          'b',
          'blockquote',
          'br',
          'caption',
          'code',
          'col',
          'colgroup',
          'dd',
          'del',
          'div',
          'dl',
          'dt',
          'em',
          'figcaption',
          'figure',
          'h1',
          'h2',
          'h3',
          'h4',
          'h5',
          'h6',
          'hr',
          'i',
          'img',
          'ins',
          'kbd',
          'li',
          'mark',
          'ol',
          'p',
          'pre',
          's',
          'samp',
          'small',
          'span',
          'strong',
          'sub',
          'sup',
          'table',
          'tbody',
          'td',
          'tfoot',
          'th',
          'thead',
          'tr',
          'u',
          'ul',
        ],
        ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'name', 'rel', 'target', 'align'],
        FORBID_ATTR: ['onerror', 'onclick', 'onload', 'onmouseover', 'style'],
        ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|tel:|data:image\/)/i,
      }) as string;
  }
  return cachedSend(html);
}
