export function documentDeepLinkUrl(documentId: string, currentHref: string) {
  const url = new URL(currentHref);
  url.searchParams.set('view', 'files');
  url.searchParams.set('document', documentId);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function pushDocumentDeepLink(documentId: string) {
  const href = documentDeepLinkUrl(documentId, window.location.href);
  window.history.pushState({ ...(window.history.state || {}), albatrossDocument: documentId }, '', href);
}
