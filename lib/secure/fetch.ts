// secure_fetch: a run calls an API with a saved key (docs/albatross-secure-store.md).
//
// The model writes the key as one `{{secure:<id>.key}}` reference in a header
// value. The request goes only to an https host that the key is saved for,
// with GET or HEAD only (reads; a write waits for approval in a later
// change), no redirect, and a 15-second limit. The answer is cut to 20 KB,
// and the key and every other saved value are removed before the model reads it.
//
// With LAB86_SECURE_FETCH_BROWSERBASE on, the call runs in a Browserbase
// session (lib/web/session-fetch.ts) and our server sends no request to the
// API host. Off (the default), our server calls the API, as before.

import { assertPublicHttpUrl } from '../attachments/fetch-store';
import { isPrivateHost } from '../shared/private-host';
import { truncateText } from '../shared/text';
import { secureFetchThroughBrowserbase, sessionFetch } from '../web/session-fetch';
import { findReferences, mentionsReference } from './policy';
import { SecureRefused, type SecureRunAccess } from './runner-access';
import { SecureScrubber } from './scrub';

export const SECURE_FETCH_MAX_CHARS = 20_000;
const READ_LIMIT_BYTES = 256 * 1024;
const TIMEOUT_MS = 15_000;
/** A cold session takes about 2.4 s more than a server call (research section 5.7). */
const SESSION_TIMEOUT_MS = 30_000;
const BLOCKED_HEADERS = new Set(['host', 'cookie', 'content-length', 'connection', 'transfer-encoding']);

export interface SecureFetchInput {
  url: string;
  method?: 'GET' | 'HEAD';
  headers?: Record<string, string>;
}

export const secureFetchDeps = {
  fetch: (url: string, init: RequestInit) => fetch(url, init),
  assertPublic: assertPublicHttpUrl,
  throughBrowserbase: () => secureFetchThroughBrowserbase(),
  sessionFetch,
};

function redirectResult(status: number, where: string) {
  return {
    ok: false,
    status,
    message: `The API answered with a redirect${where ? ` to ${where}` : ''}. secure_fetch does not follow redirects; call the final address.`,
  };
}

async function readLimited(response: Response): Promise<{ text: string; cut: boolean }> {
  if (!response.body) return { text: '', cut: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let cut = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    if (size >= READ_LIMIT_BYTES) {
      cut = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  return { text: new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))), cut };
}

export async function runSecureFetch(
  input: SecureFetchInput,
  access: SecureRunAccess,
  deps: Partial<typeof secureFetchDeps> = {},
): Promise<Record<string, unknown>> {
  const call = { ...secureFetchDeps, ...deps };
  let viaBrowserbase = false;
  try {
    if (mentionsReference(input.url))
      throw new SecureRefused('A saved key goes only in a header value, never in the address.');
    let url: URL;
    try {
      url = new URL(input.url);
    } catch {
      throw new SecureRefused('Use a full https address.');
    }
    if (url.protocol !== 'https:') throw new SecureRefused('secure_fetch calls https addresses only.');
    viaBrowserbase = call.throughBrowserbase();
    // Before any key is opened: the use history must never record a send that did not happen.
    // Through Browserbase our server never reaches the host, so a name check is enough.
    if (viaBrowserbase) {
      if (isPrivateHost(url.hostname)) throw new SecureRefused('This address is not a public API host.');
    } else
      await call.assertPublic(url.toString()).catch(() => {
        throw new SecureRefused('This address is not a public API host.');
      });
    const headers: Record<string, string> = {};
    const used = new SecureScrubber();
    let referenced = 0;
    for (const [name, raw] of Object.entries(input.headers || {})) {
      if (!/^[A-Za-z0-9-]{1,60}$/.test(name) || BLOCKED_HEADERS.has(name.toLowerCase()))
        throw new SecureRefused(`The header "${truncateText(name, 60)}" is not allowed.`);
      const references = findReferences(raw);
      if (!references.length && mentionsReference(raw))
        throw new SecureRefused('Check the {{secure:…}} reference.');
      if (references.length > 1) throw new SecureRefused('Put one saved key in one header.');
      if (!references.length) {
        headers[name] = raw;
        continue;
      }
      const resolved = await access.resolveForFetch({ reference: references[0], url: url.toString() });
      // A function replacer: "$&" or "$'" in a key must stay literal text.
      headers[name] = raw.replace(references[0].raw, () => resolved.value);
      used.add([resolved.value], resolved.label);
      referenced += 1;
    }
    if (!referenced)
      throw new SecureRefused(
        'secure_fetch needs a saved key in a header. For a public page, use browserbase_fetch.',
      );
    let status: number;
    let contentType: string;
    let read: { text: string; cut: boolean };
    if (viaBrowserbase) {
      const answer = await call.sessionFetch({
        url: url.toString(),
        method: input.method || 'GET',
        headers,
        maxBytes: READ_LIMIT_BYTES,
        signal: AbortSignal.timeout(SESSION_TIMEOUT_MS),
      });
      if (answer.status >= 300 && answer.status < 400)
        return redirectResult(answer.status, answer.redirectHost || '');
      status = answer.status;
      contentType = answer.contentType;
      read = { text: answer.body, cut: answer.cut };
    } else {
      const response = await call.fetch(url.toString(), {
        method: input.method || 'GET',
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (response.status >= 300 && response.status < 400) {
        let where = '';
        try {
          where = new URL(response.headers.get('location') || '', url).hostname;
        } catch {}
        return redirectResult(response.status, where);
      }
      status = response.status;
      contentType = (response.headers.get('content-type') || '').split(';')[0];
      read = input.method === 'HEAD' ? { text: '', cut: false } : await readLimited(response);
    }
    const scrubbed = access.cleanText(used.scrub(read.text));
    const body = truncateText(scrubbed, SECURE_FETCH_MAX_CHARS);
    return {
      ok: status >= 200 && status < 300,
      status,
      contentType,
      body,
      ...(read.cut || body.length < scrubbed.length ? { truncated: true } : {}),
    };
  } catch (error) {
    if (error instanceof SecureRefused) return { ok: false, message: error.message };
    const name = (error as Error)?.name;
    return {
      ok: false,
      message:
        name === 'TimeoutError' || name === 'AbortError'
          ? `The API did not answer in ${(viaBrowserbase ? SESSION_TIMEOUT_MS : TIMEOUT_MS) / 1_000} seconds.`
          : 'The call failed before the API answered.',
    };
  }
}
