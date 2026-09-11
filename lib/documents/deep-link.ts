export function documentDeepLinkUrl(documentId: string, currentHref: string) {
  const url = new URL(currentHref);
  url.searchParams.set('view', 'files');
  url.searchParams.set('document', documentId);
  for (const key of ['office', 'provider', 'connection', 'file', 'mime']) url.searchParams.delete(key);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function pushDocumentDeepLink(documentId: string) {
  const href = documentDeepLinkUrl(documentId, window.location.href);
  window.history.pushState({ ...(window.history.state || {}), albatrossDocument: documentId }, '', href);
}

/** Only intercept ordinary same-shell file links; modified clicks keep browser behavior. */
export function fileToolNavigationPath(value: string, currentHref: string) {
  const current = new URL(currentHref);
  const target = new URL(value, current.origin);
  if (
    current.pathname !== '/' ||
    target.origin !== current.origin ||
    target.pathname !== '/' ||
    target.searchParams.get('view') !== 'files'
  )
    return null;
  return `${target.pathname}${target.search}${target.hash}`;
}
