// secure_fetch through a Browserbase session (research section 5.7).
//
// The Fetch API has no header field, so an API call with a saved key runs in
// a short session: no saved sign-ins, no logs, no video, and main-frame
// navigation only to the API host. The server puts the key into the headers;
// a route handler adds them to the one request; a redirect hop does not get
// them. The model never sees the key, and our server sends no request to the
// API host. Behind LAB86_SECURE_FETCH_BROWSERBASE (off by default).

import { withShortSession } from './session';

export function secureFetchThroughBrowserbase(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|on|yes)$/i.test((env.LAB86_SECURE_FETCH_BROWSERBASE || '').trim());
}

export interface SessionFetchInput {
  url: string;
  method: 'GET' | 'HEAD';
  headers: Record<string, string>;
  maxBytes: number;
  signal?: AbortSignal;
}

export interface SessionFetchResult {
  status: number;
  contentType: string;
  body: string;
  cut: boolean;
  /** The host a redirect points to, when the API answered with a redirect. */
  redirectHost?: string;
}

const defaults = { withShortSession };
let deps = defaults;
export function __setSessionFetchDepsForTest(overrides: Partial<typeof defaults> = {}) {
  deps = { ...defaults, ...overrides };
}

export async function sessionFetch(input: SessionFetchInput): Promise<SessionFetchResult> {
  const url = new URL(input.url);
  return deps.withShortSession(
    { allowedDomains: [url.hostname], timeoutSeconds: 60, signal: input.signal },
    async (page) => {
      const response = await page.requestWithHeaders({
        url: url.toString(),
        method: input.method,
        headers: input.headers,
        maxBytes: input.maxBytes,
      });
      const contentType = (response.headers['content-type'] || '').split(';')[0].trim();
      if (response.status >= 300 && response.status < 400) {
        let redirectHost = '';
        try {
          redirectHost = new URL(response.location || '', url).hostname;
        } catch {}
        return { status: response.status, contentType, body: '', cut: false, redirectHost };
      }
      return { status: response.status, contentType, body: response.body, cut: response.cut };
    },
  );
}
