// A srcdoc frame inherits the Content-Security-Policy of the page that holds
// it, also when the frame is sandboxed. Under the page policy
// (lib/security/csp.ts), an inline script runs only when it carries the page
// nonce, and an inline event handler never runs. The brief, area, and canvas
// frames need their inline runtime scripts, so the host puts the page nonce on
// every script of the frame document before it sets srcDoc.
//
// The frame stays sandboxed with an opaque origin, so this gives its scripts
// no more power than they had before the page policy.

const SCRIPT_OPEN = /<script\b([^>]*)>/gi;
const NONCE_ATTRIBUTE = /\snonce\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;
const SRCDOC_ATTRIBUTE = /(\ssrcdoc\s*=\s*)(?:"([^"]*)"|'([^']*)')/gi;
const IMAGE_ONERROR = /(<img\b[^>]*?)\sonerror\s*=\s*(?:"[^"]*"|'[^']*')/gi;
const NONCE_VALUE = /^[A-Za-z0-9+/=_-]{8,128}$/;

// Replaces the inline onerror handlers of stored briefs: the hero image tries
// its data-fallbacks list, then hides; any other image hides.
const IMAGE_FALLBACK_RUNTIME = `document.addEventListener('error',function(e){var img=e.target;if(!img||img.tagName!=='IMG'||!img.hasAttribute('data-lab86-onerror'))return;var f=[];try{f=JSON.parse(img.getAttribute('data-fallbacks')||'[]')||[];}catch(_){f=[];}if(f.length){img.setAttribute('data-fallbacks',JSON.stringify(f.slice(1)));img.src=f[0];return;}img.removeAttribute('data-lab86-onerror');img.style.display='none';var h=img.closest&&img.closest('.hero');if(h)h.style.background='var(--brief-accent-soft)';},true);`;

/** The nonce of the current page, read from a script that Next.js rendered. */
export function documentCspNonce(doc: Pick<Document, 'querySelector'> | undefined = globalThis.document) {
  const script = doc?.querySelector?.('script[nonce]') as HTMLScriptElement | null | undefined;
  // Browsers hide the attribute value after load; the property keeps it.
  return script?.nonce || script?.getAttribute('nonce') || '';
}

function decodeAttribute(value: string) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function encodeAttribute(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function insertAtDocumentStart(html: string, fragment: string) {
  const head = /<head\b[^>]*>/i.exec(html);
  if (head)
    return `${html.slice(0, head.index + head[0].length)}${fragment}${html.slice(head.index + head[0].length)}`;
  const root = /<html\b[^>]*>/i.exec(html);
  if (root)
    return `${html.slice(0, root.index + root[0].length)}${fragment}${html.slice(root.index + root[0].length)}`;
  return `${fragment}${html}`;
}

/**
 * Puts `nonce` on every script of a frame document, also inside nested srcdoc
 * frames, and replaces inline image onerror handlers with one script. With
 * no valid nonce (no page policy) the document is returned unchanged.
 */
export function withFrameNonce(html: string, nonce: string): string {
  if (!html || !NONCE_VALUE.test(nonce)) return html;
  // Nested frame documents first, so their scripts are handled as documents
  // of their own and the outer pass cannot see into the attribute.
  const nested: string[] = [];
  let next = html.replace(SRCDOC_ATTRIBUTE, (_match, lead: string, doubled?: string, single?: string) => {
    const inner = withFrameNonce(decodeAttribute(doubled ?? single ?? ''), nonce);
    nested.push(`${lead}"${encodeAttribute(inner)}"`);
    return `\uE000${nested.length - 1}\uE000`;
  });
  let handlers = false;
  next = next.replace(IMAGE_ONERROR, (_match, head: string) => {
    handlers = true;
    return `${head} data-lab86-onerror`;
  });
  next = next.replace(
    SCRIPT_OPEN,
    (_match, attributes: string) => `<script${attributes.replace(NONCE_ATTRIBUTE, '')} nonce="${nonce}">`,
  );
  if (handlers) {
    next = insertAtDocumentStart(
      next,
      `<script id="lab86-image-fallback-js" nonce="${nonce}">${IMAGE_FALLBACK_RUNTIME}</script>`,
    );
  }
  return next.replace(/\uE000(\d+)\uE000/g, (_match, index: string) => nested[Number(index)]);
}
