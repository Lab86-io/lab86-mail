// The app may hand off only product destinations, never an arbitrary redirect,
// API, authentication callback, or external URL. Query values are opaque IDs.
const paths = new Set(['/', '/settings', '/narrative', '/native/files']);
const queryKeys = new Set([
  'view',
  'document',
  'office',
  'provider',
  'connection',
  'file',
  'mime',
  'area',
  'work',
  'account',
  'thread',
  'event',
  'calendar',
  'section',
]);

export function nativeBrowserDestination(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    [...value].some((character) => character === '\\' || character.charCodeAt(0) <= 32) ||
    value.length > 4096
  )
    return null;
  const url = new URL(value, 'https://native.invalid');
  if (url.origin !== 'https://native.invalid' || !paths.has(url.pathname) || url.hash) return null;
  for (const name of url.searchParams.keys()) if (!queryKeys.has(name)) return null;
  return `${url.pathname}${url.search}`;
}
