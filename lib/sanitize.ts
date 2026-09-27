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
  if (!cachedRead) cachedRead = createInlineEmailSanitizer(getDOMPurify());
  return cachedRead(html);
}

// The inline read path renders mail straight into the app DOM, so mail must
// not be able to draw over the app: form controls are removed, and inline
// styles lose the properties that lift an element out of the message box
// (fixed or absolute positioning, stacking, offsets, transforms). The
// `.email-body` container also sets `contain: paint` as a second layer.
const INLINE_FORBID_TAGS = [
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'link',
  'meta',
  'base',
  'form',
  'input',
  'button',
  'textarea',
  'select',
  'option',
  'optgroup',
  'fieldset',
  'legend',
  'label',
  'dialog',
];

const INLINE_BLOCKED_STYLE =
  /^(?:position|z-index|inset(?:-.+)?|top|right|bottom|left|transform|translate|rotate|scale|float|clip-path|pointer-events|content|behavior|-moz-binding|filter|backdrop-filter)$/i;

/** Keep only style declarations that stay inside the message box. */
export function containInlineStyle(style: string): string {
  return style
    .split(';')
    .map((declaration) => declaration.trim())
    .filter((declaration) => {
      const colon = declaration.indexOf(':');
      if (colon <= 0) return false;
      const property = declaration.slice(0, colon).trim();
      const value = declaration.slice(colon + 1).toLowerCase();
      if (INLINE_BLOCKED_STYLE.test(property)) return false;
      return !/expression\s*\(|javascript:|url\s*\(\s*['"]?\s*(?!https?:|data:image\/)/i.test(value);
    })
    .join('; ');
}

/** Build the inline sanitizer on a DOMPurify instance (exported for tests). */
export function createInlineEmailSanitizer(instance: any): (html: string) => string {
  instance.addHook(
    'uponSanitizeAttribute',
    (_node: Element, data: { attrName: string; attrValue: string; keepAttr: boolean }) => {
      if (data.attrName !== 'style') return;
      const contained = containInlineStyle(data.attrValue || '');
      if (contained) data.attrValue = contained;
      else data.keepAttr = false;
    },
  );
  return (input: string) =>
    instance.sanitize(input, {
      FORBID_TAGS: INLINE_FORBID_TAGS,
      FORBID_ATTR: ['onerror', 'onclick', 'onload', 'onmouseover', 'formaction', 'form'],
      // Raster image data: URIs only — keeps inline signature images working
      // while excluding svg+xml and other embeddable documents.
      ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|tel:|data:image\/(?:png|jpe?g|gif|webp|bmp);base64,)/i,
    }) as string;
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
