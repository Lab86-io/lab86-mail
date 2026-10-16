import { afterEach, describe, expect, test } from 'bun:test';
import './tools/harness';
import { AGENT_TOOL_NAMES } from '../lib/ai/loop';
import { TOOL_GROUPS } from '../lib/ai/tool-groups';
import { RUNNER_SHAPED_TOOL_NAMES, resolveToolShape, SHAPED_TOOL_NAMES } from '../lib/ai/tool-shapes';
import { __setFetchWebFileDepsForTest, fetchWebFile } from '../lib/attachments/fetch-store';
import { formatFileSize } from '../lib/chat/shape-format';
import { runSecureFetch } from '../lib/secure/fetch';
import { SecureRefused, type SecureRunAccess } from '../lib/secure/runner-access';
import { SecureScrubber } from '../lib/secure/scrub';
import { getTool } from '../lib/tools/index';
import { browserbaseFetch, browserbaseSearch, webFileSave, webResearch } from '../lib/tools/web';
import { BrowserbaseRequestError } from '../lib/web/browserbase-client';
import { __setFilePullDepsForTest, SAVE_FILE_KINDS } from '../lib/web/file-pull';
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
  test('registered, given to the chat agent, and core (no group to load first)', () => {
    for (const name of ['browserbase_search', 'browserbase_fetch', 'web_research', 'web_file_save']) {
      expect(getTool(name)).toBeTruthy();
      expect(AGENT_TOOL_NAMES.has(name)).toBe(true);
    }
    const grouped = new Set<string>(Object.values(TOOL_GROUPS).flatMap((group) => [...group.tools]));
    for (const name of ['web_research', 'web_file_save']) expect(grouped.has(name)).toBe(false);
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
    expect(calls).toEqual([
      ['https://example.com/invoice', { name: 'Invoice', kinds: [...SAVE_FILE_KINDS, 'txt'] }],
    ]);
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

describe('web tool shapes', () => {
  const saved = {
    ok: true,
    fileId: 'f1',
    title: 'Form W-9.pdf',
    openPath: '/?view=files&file=f1',
    size: 140815,
    contentType: 'application/pdf',
    sourceUrl: 'https://www.irs.gov/pub/irs-pdf/fw9.pdf',
    sha256: 'abc',
  };

  test('web_research: numbered sources with the host and a link; no passages', () => {
    const shape = resolveToolShape(
      'web_research',
      { question: 'Which W-9 revision is current?', queries: ['w9'] },
      {
        ok: true,
        sources: [
          { n: 1, title: 'About Form W-9', url: 'https://www.irs.gov/w9', passage: 'Rev. March 2024' },
          { title: '', url: 'https://blog.example/w9', passage: 'x' },
        ],
        failed: [],
      },
    );
    expect(shape).toMatchObject({ kind: 'sources', title: 'Sources for “Which W-9 revision is current?”' });
    if (shape?.kind !== 'sources') throw new Error('sources expected');
    expect(shape.items).toEqual([
      {
        title: '1. About Form W-9',
        url: 'https://www.irs.gov/w9',
        snippet: undefined,
        source: undefined,
        actions: [{ kind: 'open_url', url: 'https://www.irs.gov/w9' }],
      },
      {
        title: '2. blog.example',
        url: 'https://blog.example/w9',
        snippet: undefined,
        source: undefined,
        actions: [{ kind: 'open_url', url: 'https://blog.example/w9' }],
      },
    ]);
    expect(shape.activity.done).toBe('Read 2 sources for “Which W-9 revision is current?”');
    expect(
      resolveToolShape('web_research', { question: 'q' }, { ok: true, sources: [], failed: ['x'] }),
    ).toBeNull();
  });

  test('web_file_save and browser_download: one file row that opens the file in Files', () => {
    const shape = resolveToolShape('web_file_save', { url: saved.sourceUrl }, saved);
    expect(shape).toMatchObject({ kind: 'files', title: 'Saved in Files', actions: [] });
    if (shape?.kind !== 'files') throw new Error('files expected');
    expect(shape.items).toEqual([
      {
        connectionId: 'files',
        fileId: 'f1',
        name: 'Form W-9.pdf',
        kind: 'PDF',
        source: 'irs.gov',
        mimeType: 'application/pdf',
        size: 140815,
        actions: [{ kind: 'open_document', documentId: 'f1', path: '/?view=files&file=f1' }],
      },
    ]);
    expect(shape.activity.done).toBe('Saved Form W-9.pdf in Files');
    expect(RUNNER_SHAPED_TOOL_NAMES.has('browser_download')).toBe(true);
    expect(SHAPED_TOOL_NAMES.has('browser_download')).toBe(false);
    const download = resolveToolShape(
      'browser_download',
      { ref: 'e4' },
      { ...saved, sourceUrl: undefined, contentType: 'text/csv' },
    );
    if (download?.kind !== 'files') throw new Error('files expected');
    expect(download.items[0]).toMatchObject({ kind: 'CSV', fileId: 'f1' });
    expect(download.items[0].source).toBeUndefined();
    expect(download.activity.running).toBe('Saving the file from the page');
    const kinds = [
      ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'doc'],
      ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'sheet'],
      ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'deck'],
      ['image/png', 'Image'],
      ['text/plain', 'Text'],
      ['application/zip', undefined],
    ];
    for (const [contentType, kind] of kinds) {
      const row = resolveToolShape('web_file_save', {}, { ...saved, contentType });
      if (row?.kind !== 'files') throw new Error('files expected');
      expect(row.items[0].kind).toBe(kind);
    }
    const bare = resolveToolShape('web_file_save', {}, { ok: true, fileId: 'f2' });
    if (bare?.kind !== 'files') throw new Error('files expected');
    expect(bare.items[0]).toEqual({ connectionId: 'files', fileId: 'f2', name: 'File', actions: [] });
    expect(resolveToolShape('web_file_save', {}, { ok: true })).toBeNull();
    expect(resolveToolShape('browser_download', {}, { ok: false, message: 'x' })).toBeNull();
  });

  test('file sizes read as bytes, KB, or MB', () => {
    expect(formatFileSize(undefined)).toBe('');
    expect(formatFileSize(-1)).toBe('');
    expect(formatFileSize(812)).toBe('812 bytes');
    expect(formatFileSize(140815)).toBe('138 KB');
    expect(formatFileSize(4.2 * 1024 * 1024)).toBe('4.2 MB');
  });
});
