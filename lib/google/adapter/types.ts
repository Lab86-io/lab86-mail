// Direct Google transport: the adapter shape.
//
// The adapter answers the Nylas SDK calls that the app makes, with the same
// argument and result shapes, so no caller changes. Lists return
// `{ data, requestId, nextCursor? }`; finds return `{ data, requestId }`;
// `attachments.download` returns a web ReadableStream.

/** SDK resources that `requireNylas()` routes by grant id. */
export const ROUTED_RESOURCES = [
  'messages',
  'threads',
  'folders',
  'attachments',
  'drafts',
  'events',
  'calendars',
  'contacts',
  'grants',
] as const;

export type RoutedResource = (typeof ROUTED_RESOURCES)[number];

export type AdapterMethod = (args: any, ...rest: any[]) => Promise<any>;
export type AdapterResource = Record<string, AdapterMethod>;
export type GoogleNylasAdapter = Partial<Record<RoutedResource, AdapterResource>>;
