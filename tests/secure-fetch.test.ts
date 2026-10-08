import { describe, expect, test } from 'bun:test';
import { runSecureFetch } from '../lib/secure/fetch';
import { SecureRefused, type SecureRunAccess } from '../lib/secure/runner-access';
import { SecureScrubber } from '../lib/secure/scrub';

// secure_fetch: an API call with a saved key (docs/albatross-secure-store.md).

const key = ['sk-', 'abcdefghijklmnop', 'f3a2'].join('');
const ITEM = 'si_key0000000000000000000';

function access(): SecureRunAccess {
  const scrubber = new SecureScrubber();
  scrubber.add([key], 'OpenAI');
  return {
    cleanPage: async (_url, parts) => parts.map((part) => scrubber.scrub(part)),
    cleanText: (text) => scrubber.scrub(text),
    resolveForField: async () => {
      throw new Error('unused');
    },
    resolveForFetch: async ({ url }) => {
      if (!new URL(url).hostname.endsWith('api.openai.com'))
        throw new SecureRefused('OpenAI is saved for api.openai.com.');
      return { value: key, label: 'OpenAI key' };
    },
    pendingAllow: () => null,
    signInOffer: async () => null,
  };
}

const ok = async () => undefined;

describe('runSecureFetch', () => {
  test('the key goes into the header; the answer comes back scrubbed', async () => {
    const seen: any[] = [];
    const result = await runSecureFetch(
      {
        url: 'https://api.openai.com/v1/models',
        headers: { Authorization: `Bearer {{secure:${ITEM}.key}}`, Accept: 'application/json' },
      },
      access(),
      {
        assertPublic: ok as any,
        fetch: async (url, init) => {
          seen.push({ url, init });
          return new Response(JSON.stringify({ echo: key, data: ['gpt'] }), {
            status: 200,
            headers: { 'content-type': 'application/json; charset=utf-8' },
          });
        },
      },
    );
    expect(seen[0].init.headers).toEqual({ Authorization: `Bearer ${key}`, Accept: 'application/json' });
    expect(seen[0].init.redirect).toBe('manual');
    expect(seen[0].init.method).toBe('GET');
    expect(result).toEqual({
      ok: true,
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ echo: '[secure: OpenAI key]', data: ['gpt'] }),
    });
  });

  test('refusals: a key in the address, http, no key, a blocked header, two keys, a wrong host', async () => {
    const deps = { assertPublic: ok as any, fetch: async () => new Response('x') };
    const cases: Array<[Parameters<typeof runSecureFetch>[0], RegExp]> = [
      [{ url: `https://api.openai.com/?k={{secure:${ITEM}.key}}` }, /never in the address/],
      [{ url: 'http://api.openai.com/', headers: { A: `{{secure:${ITEM}.key}}` } }, /https addresses only/],
      [{ url: 'nope' }, /full https address/],
      [{ url: 'https://api.openai.com/', headers: { Accept: 'x' } }, /needs a saved key/],
      [{ url: 'https://api.openai.com/', headers: { Cookie: `{{secure:${ITEM}.key}}` } }, /not allowed/],
      [
        { url: 'https://api.openai.com/', headers: { A: `{{secure:${ITEM}.key}}{{secure:${ITEM}.key}}` } },
        /one saved key/,
      ],
      [{ url: 'https://api.openai.com/', headers: { A: '{{secure:broken' } }, /Check the/],
      [
        { url: 'https://evil.example/', headers: { A: `{{secure:${ITEM}.key}}` } },
        /saved for api.openai.com/,
      ],
    ];
    for (const [input, message] of cases) {
      const result = await runSecureFetch(input, access(), deps);
      expect(result.ok).toBe(false);
      expect(String(result.message)).toMatch(message);
    }
  });

  test('a private host, a redirect, a timeout, and a long answer', async () => {
    const input = {
      url: 'https://api.openai.com/v1/x',
      headers: { Authorization: `Bearer {{secure:${ITEM}.key}}` },
    };
    // A private host is refused before any key is opened, so no use is recorded.
    let opened = 0;
    expect(
      await runSecureFetch(
        input,
        {
          ...access(),
          resolveForFetch: async () => {
            opened += 1;
            return { value: key, label: 'OpenAI key' };
          },
        },
        {
          assertPublic: async () => {
            throw new Error('private');
          },
        },
      ),
    ).toEqual({ ok: false, message: 'This address is not a public API host.' });
    expect(opened).toBe(0);
    expect(
      await runSecureFetch(input, access(), {
        assertPublic: ok as any,
        fetch: async () =>
          new Response(null, { status: 302, headers: { location: 'https://other.example/x' } }),
      }),
    ).toMatchObject({ ok: false, status: 302, message: expect.stringContaining('to other.example') });
    expect(
      await runSecureFetch(input, access(), {
        assertPublic: ok as any,
        fetch: async () => {
          throw Object.assign(new Error('t'), { name: 'TimeoutError' });
        },
      }),
    ).toEqual({ ok: false, message: 'The API did not answer in 15 seconds.' });
    expect(
      await runSecureFetch(input, access(), {
        assertPublic: ok as any,
        fetch: async () => {
          throw new Error(`boom ${key}`);
        },
      }),
    ).toEqual({ ok: false, message: 'The call failed before the API answered.' });
    const long = await runSecureFetch(input, access(), {
      assertPublic: ok as any,
      fetch: async () => new Response('a'.repeat(300_000), { status: 500 }),
    });
    expect(long).toMatchObject({ ok: false, status: 500, truncated: true });
    expect(String(long.body).length).toBeLessThanOrEqual(20_000);
    const head = await runSecureFetch({ ...input, method: 'HEAD' }, access(), {
      assertPublic: ok as any,
      fetch: async () => new Response(null, { status: 204 }),
    });
    expect(head).toMatchObject({ ok: true, status: 204, body: '' });
  });
});

test('a "$" in a key stays literal in the header and in the scrub', async () => {
  const dollarKey = ['abcDEF123', "$'", 'ghiJKL456'].join('');
  const scrubber = new SecureScrubber();
  scrubber.add([dollarKey], 'Service');
  const seen: any[] = [];
  const result = await runSecureFetch(
    {
      url: 'https://api.openai.com/v1/x',
      headers: { Authorization: `Bearer {{secure:${ITEM}.key}} trailing` },
    },
    {
      ...access(),
      resolveForFetch: async () => ({ value: dollarKey, label: 'Service key' }),
      cleanText: (text: string) => scrubber.scrub(text),
    },
    {
      assertPublic: (async () => undefined) as any,
      fetch: async (_url, init) => {
        seen.push(init);
        return new Response(`echo ${(init.headers as Record<string, string>).Authorization}`);
      },
    },
  );
  expect(seen[0].headers.Authorization).toBe(`Bearer ${dollarKey} trailing`);
  expect(String(result.body)).not.toContain('ghiJKL456');
});
