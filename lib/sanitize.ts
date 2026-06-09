'use client';

// Browser-only DOMPurify wrappers. Server-side these return empty — the
// caller should only use the sanitized HTML after mount to avoid SSR/client
// divergence.

let cachedRead: ((html: string) => string) | null = null;
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
        ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|tel:|data:image\/)/i,
      }) as string;
  }
  return cachedRead(html);
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
