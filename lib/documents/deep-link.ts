export function documentDeepLinkUrl(documentId: string, currentHref: string) {
  const url = new URL(currentHref);
  url.searchParams.set('view', 'files');
  url.searchParams.set('document', documentId);
  for (const key of ['office', 'provider', 'connection', 'file', 'mime']) url.searchParams.delete(key);
  return `${url.pathname}${url.search}${url.hash}`;
}

/** The Files link that opens one Google-native file in its editor. */
export function googleFileDeepLinkUrl(
  source: { connectionId: string; fileId: string; mimeType: string },
  currentHref: string,
) {
  const url = new URL(currentHref);
  url.searchParams.set('view', 'files');
  for (const key of ['document', 'office']) url.searchParams.delete(key);
  url.searchParams.set('provider', 'google_drive');
  url.searchParams.set('connection', source.connectionId);
  url.searchParams.set('file', source.fileId);
  url.searchParams.set('mime', source.mimeType);
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
    !['/', '/native/files'].includes(current.pathname) ||
    target.origin !== current.origin ||
    target.pathname !== '/' ||
    target.searchParams.get('view') !== 'files'
  )
    return null;
  return `${current.pathname}${target.search}${target.hash}`;
}
