'use client';

// Browser-only DOMPurify wrapper. Server-side this module returns the input
// unchanged — the surrounding component should only render the sanitized HTML
// after mount to avoid SSR/client divergence.

let cached: ((html: string) => string) | null = null;

export function sanitizeEmailHtml(html: string): string {
  if (typeof window === 'undefined') return '';
  if (!cached) {
    // Lazy require so SSR never touches the package.
    const DOMPurify: any = (require('dompurify') as any).default ?? require('dompurify');
    const instance = DOMPurify(window);
    cached = (input: string) =>
      instance.sanitize(input, {
        FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta'],
        FORBID_ATTR: ['onerror', 'onclick', 'onload', 'onmouseover'],
        ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|tel:|data:image\/)/i,
      }) as string;
  }
  return cached(html);
}
