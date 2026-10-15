import { afterEach, describe, expect, test } from 'bun:test';
import './tools/harness';
import { AGENT_TOOL_NAMES } from '../lib/ai/loop';
import { TOOL_GROUPS } from '../lib/ai/tool-groups';
import { __setFetchWebFileDepsForTest, fetchWebFile } from '../lib/attachments/fetch-store';
import { runSecureFetch } from '../lib/secure/fetch';
import { SecureRefused, type SecureRunAccess } from '../lib/secure/runner-access';
import { SecureScrubber } from '../lib/secure/scrub';
import { getTool } from '../lib/tools/index';
import { browserbaseFetch, browserbaseSearch, webFileSave, webResearch } from '../lib/tools/web';
import { BrowserbaseRequestError } from '../lib/web/browserbase-client';
import { __setFilePullDepsForTest } from '../lib/web/file-pull';
import { __setWebReadDepsForTest } from '../lib/web/read';
import { __setWebResearchDepsForTest } from '../lib/web/research';
import type { SessionPage } from '../lib/web/session';
import {
  __setSessionFetchDepsForTest,
  secureFetchThroughBrowserbase,
  sessionFetch,
} from '../lib/web/session-fetch';
import { testEnv } from './tools/env';
import { runTool } from './tools/harness';

afterEach(() => {
  __setWebReadDepsForTest();
  __setWebResearchDepsForTest();
  __setFilePullDepsForTest();
  __setFetchWebFileDepsForTest();
  __setSessionFetchDepsForTest();
});

const PDF = new Uint8Array(Buffer.from('%PDF-1.7 test'));

describe('web tools', () => {
  test('registered, given to the chat agent, and in the web group', () => {
    for (const name of ['browserbase_search', 'browserbase_fetch', 'web_research', 'web_file_save']) {
      expect(getTool(name)).toBeTruthy();
      expect(AGENT_TOOL_NAMES.has(name)).toBe(true);
    }
    expect([...TOOL_GROUPS.web.tools]).toEqual(['web_research', 'web_file_save']);
    expect(browserbaseSearch.description).toContain('no snippets');
    expect(webFileSave.description).toContain('irs.gov');
    expect(webResearch.description).toContain('6 searches');
    expect(webFileSave.risk).toBe('write_self');
  });

  test('browserbase_search and browserbase_fetch use the read module', async () => {
    __setWebReadDepsForTest({
      search: async () => [{ url: 'https://www.irs.gov/w9', title: 'W-9' }],
      fetch: async (input) => {
        if (input.format === 'markdown') throw new BrowserbaseRequestError('x', 400);
        return {
          statusCode: 200,
          headers: {},
          content: Buffer.from(PDF).toString('base64'),
          contentType: 'application/pdf',
          encoding: 'base64',
        };
      },
      extract: async () => ({ text: '[Page 1]\nForm W-9', partial: false }),
    });
    expect(await runTool(browserbaseSearch.handler, { query: 'w9', limit: 3 })).toEqual({
      results: [{ title: 'W-9', url: 'https://www.irs.gov/w9' }],
    });
    expect(
      await runTool(browserbaseFetch.handler, { url: 'https://www.irs.gov/pub/irs-pdf/fw9.pdf' }),
    ).toEqual({
      url: 'https://www.irs.gov/pub/irs-pdf/fw9.pdf',
      contentType: 'application/pdf',
      content: '[Page 1]\nForm W-9',
    });
    const controller = new AbortController();
    let signal: AbortSignal | undefined;
    __setWebReadDepsForTest({
      fetch: async (_input, options) => {
        signal = options?.signal;
        return { statusCode: 200, headers: {}, content: 'Hi', contentType: 'text/markdown' };
      },
    });
    await runTool(browserbaseFetch.handler, { url: 'https://a.test/' }, { abortSignal: controller.signal });
    expect(signal).toBe(controller.signal);
  });

  test('web_research passes the user and the question', async () => {
    let seenUser: string | null | undefined;
    __setWebResearchDepsForTest({
      searchWeb: async () => [{ title: 'A', url: 'https://a.test/' }],
      readPage: async (url) => ({
        url,
        contentType: 'text/markdown',
        content: `${'A paragraph about the topic of the question here and more. '.repeat(10)}`,
      }),
      savedContextId: async (userId) => {
        seenUser = userId;
        return null;
      },
    });
    const result = await runTool(webResearch.handler, {
      question: 'topic?',
      queries: ['topic'],
      sites: ['a.test'],
    });
    expect(result.sources.map((source) => source.n)).toEqual([1]);
    expect(seenUser).toBeUndefined();
  });

  test('web_file_save saves the file and returns the shared result shape', async () => {
    const saved: any[] = [];
    __setFilePullDepsForTest({
      fetchRaw: async () => ({
        statusCode: 200,
        headers: {},
        content: Buffer.from(PDF).toString('base64'),
        contentType: 'application/pdf',
        encoding: 'base64',
      }),
      saveFileBytes: (async (input: any) => {
        saved.push(input);
        return {
          fileId: 'f1',
          title: input.name,
          openPath: '/?view=files&file=f1',
          size: 13,
          contentType: input.contentType,
          sha256: 'abc',
          sourceUrl: input.sourceUrl,
        };
      }) as any,
    });
    expect(
      await runTool(webFileSave.handler, {
        url: 'https://www.irs.gov/pub/irs-pdf/fw9.pdf',
        name: 'Form W-9',
      }),
    ).toEqual({
      ok: true,
      fileId: 'f1',
      title: 'Form W-9.pdf',
      openPath: '/?view=files&file=f1',
      size: 13,
      contentType: 'application/pdf',
      sourceUrl: 'https://www.irs.gov/pub/irs-pdf/fw9.pdf',
      sha256: 'abc',
    });
    expect(saved[0]).toMatchObject({ userId: 'test_user_tools', origin: 'web' });
    await expect(runTool(webFileSave.handler, { url: 'http://127.0.0.1/x.pdf' })).rejects.toThrow(
      /private network/,
    );
    await expect(
      runTool(webFileSave.handler, { url: 'https://a.test/x.pdf' }, { userId: null }),
    ).rejects.toThrow('Sign in required to save a file.');
    __setFilePullDepsForTest({
      fetchRaw: async () => {
        throw new Error('network down');
      },
    });
    await expect(runTool(webFileSave.handler, { url: 'https://a.test/x.pdf' })).rejects.toThrow(
      'network down',
    );
  });
});

describe('fetchWebFile', () => {
  test('goes through the file pull with the normalized address and the name', async () => {
    const calls: unknown[] = [];
    __setFetchWebFileDepsForTest({
      pullWebFile: (async (url: string, options: any) => {
        calls.push([url, options]);
        return { bytes: PDF, contentType: 'application/pdf', name: 'Invoice.pdf' };
      }) as any,
    });
    expect(await fetchWebFile('example.com/invoice', 'Invoice')).toEqual({
      bytes: PDF,
      contentType: 'application/pdf',
      name: 'Invoice.pdf',
    });
    expect(calls).toEqual([['https://example.com/invoice', { name: 'Invoice' }]]);
    await expect(fetchWebFile('   ')).rejects.toThrow('Not a usable URL');
  });
});

describe('secure_fetch through Browserbase', () => {
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
          throw new SecureRefused('Saved for api.openai.com.');
        return { value: key, label: 'OpenAI key' };
      },
      pendingAllow: () => null,
      signInOffer: async () => null,
    };
  }
  const input = {
    url: 'https://api.openai.com/v1/models',
    headers: { Authorization: `Bearer {{secure:${ITEM}.key}}` },
  };

  test('the flag is off unless set', () => {
    expect(secureFetchThroughBrowserbase(testEnv({}))).toBe(false);
    expect(secureFetchThroughBrowserbase(testEnv({ LAB86_SECURE_FETCH_BROWSERBASE: ' on ' }))).toBe(true);
    expect(secureFetchThroughBrowserbase(testEnv({ LAB86_SECURE_FETCH_BROWSERBASE: '1' }))).toBe(true);
    expect(secureFetchThroughBrowserbase(testEnv({ LAB86_SECURE_FETCH_BROWSERBASE: 'off' }))).toBe(false);
  });

  test('the key goes to the session in a header; the server makes no request; the answer is scrubbed', async () => {
    const seen: any[] = [];
    const result = await runSecureFetch(input, access(), {
      throughBrowserbase: () => true,
      assertPublic: async () => {
        throw new Error('no server DNS check on this path');
      },
      fetch: async () => {
        throw new Error('no server request on this path');
      },
      sessionFetch: async (call) => {
        seen.push(call);
        return {
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ echo: key }),
          cut: true,
        };
      },
    });
    expect(seen[0]).toMatchObject({
      url: 'https://api.openai.com/v1/models',
      method: 'GET',
      headers: { Authorization: `Bearer ${key}` },
      maxBytes: 256 * 1024,
    });
    expect(result).toEqual({
      ok: true,
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ echo: '[secure: OpenAI key]' }),
      truncated: true,
    });
  });

  test('a redirect, a private host, an error status, and a time limit', async () => {
    const redirect = await runSecureFetch(input, access(), {
      throughBrowserbase: () => true,
      sessionFetch: async () => ({
        status: 302,
        contentType: '',
        body: '',
        cut: false,
        redirectHost: 'login.example',
      }),
    });
    expect(redirect).toEqual({
      ok: false,
      status: 302,
      message:
        'The API answered with a redirect to login.example. secure_fetch does not follow redirects; call the final address.',
    });
    expect(
      await runSecureFetch({ ...input, url: 'https://10.0.0.2/v1' }, access(), {
        throughBrowserbase: () => true,
        sessionFetch: async () => {
          throw new Error('unused');
        },
      }),
    ).toEqual({ ok: false, message: 'This address is not a public API host.' });
    const denied = await runSecureFetch({ ...input, method: 'HEAD' }, access(), {
      throughBrowserbase: () => true,
      sessionFetch: async () => ({ status: 401, contentType: 'application/json', body: '', cut: false }),
    });
    expect(denied).toEqual({ ok: false, status: 401, contentType: 'application/json', body: '' });
    const late = await runSecureFetch(input, access(), {
      throughBrowserbase: () => true,
      sessionFetch: async () => {
        throw new DOMException('late', 'TimeoutError');
      },
    });
    expect(late).toEqual({ ok: false, message: 'The API did not answer in 30 seconds.' });
  });

  test('sessionFetch: a session with only the API host, the headers on one request, a redirect host', async () => {
    const opened: any[] = [];
    let answer: any = {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: '{}',
      cut: false,
    };
    const page: SessionPage = {
      open: async () => {
        throw new Error('unused');
      },
      title: async () => '',
      text: async () => '',
      fetchInPage: async () => {
        throw new Error('unused');
      },
      requestWithHeaders: async (request) => {
        opened.push(request);
        return answer;
      },
    };
    __setSessionFetchDepsForTest({
      withShortSession: (async (sessionInput: any, task: any) => {
        opened.push(sessionInput);
        return task(page, 's1');
      }) as any,
    });
    expect(
      await sessionFetch({
        url: 'https://api.example/v1/me#x',
        method: 'GET',
        headers: { A: 'b' },
        maxBytes: 10,
      }),
    ).toEqual({ status: 200, contentType: 'application/json', body: '{}', cut: false });
    expect(opened[0]).toEqual({ allowedDomains: ['api.example'], timeoutSeconds: 60, signal: undefined });
    expect(opened[1]).toEqual({
      url: 'https://api.example/v1/me',
      method: 'GET',
      headers: { A: 'b' },
      maxBytes: 10,
    });
    answer = { status: 301, headers: {}, body: '', cut: false, location: 'https://other.example/x' };
    expect(
      await sessionFetch({ url: 'https://api.example/v1', method: 'GET', headers: {}, maxBytes: 10 }),
    ).toEqual({
      status: 301,
      contentType: '',
      body: '',
      cut: false,
      redirectHost: 'other.example',
    });
    answer = { status: 307, headers: {}, body: '', cut: false, location: 'http://[bad' };
    expect(
      (await sessionFetch({ url: 'https://api.example/v1', method: 'GET', headers: {}, maxBytes: 10 }))
        .redirectHost,
    ).toBe('');
  });
});
