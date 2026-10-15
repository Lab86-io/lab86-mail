import { afterEach, describe, expect, test } from 'bun:test';
import { BrowserbaseRequestError } from '../lib/web/browserbase-client';
import type { PageRead, WebSearchHit } from '../lib/web/read';
import {
  __setWebResearchDepsForTest,
  pickPassage,
  RESEARCH_LIMITS,
  researchTerms,
  runWebResearch,
  siteHost,
} from '../lib/web/research';
import type { SessionPage } from '../lib/web/session';

afterEach(() => __setWebResearchDepsForTest());

const LONG = (topic: string) =>
  `# ${topic}\n\nMenu\n\n${'Intro text about the agency and its many services for people. '.repeat(4)}\n\nUse Form W-9 to give your correct taxpayer identification number to the person who must file an information return. The current revision is March 2024.\n\n${'Footer words about contact pages and help. '.repeat(6)}`;

describe('helpers', () => {
  test('siteHost takes a bare host, an address, or www', () => {
    expect(siteHost('irs.gov')).toBe('irs.gov');
    expect(siteHost('https://www.IRS.gov/forms')).toBe('irs.gov');
    expect(siteHost('  ')).toBe('');
    expect(siteHost('http://')).toBe('');
  });

  test('researchTerms keeps the words that matter, once', () => {
    expect(researchTerms('What is the current revision of Form W-9?', ['W-9 revision 2024'])).toEqual([
      'current',
      'revision',
      'w-9',
      '2024',
    ]);
  });

  test('pickPassage takes the best blocks in page order, or the first real paragraph', () => {
    const text = LONG('About Form W-9');
    const passage = pickPassage(text, ['w-9', 'revision', 'march']);
    expect(passage).toContain('The current revision is March 2024.');
    expect(passage.length).toBeLessThanOrEqual(RESEARCH_LIMITS.passageChars);
    expect(pickPassage(text, ['nothing-matches'])).toContain('Intro text about the agency');
    expect(pickPassage('short\n\nlines', ['x'])).toBe('');
    const long = `${'A sentence about the topic and w-9 forms here. '.repeat(30)}`;
    const cut = pickPassage(long, ['w-9'], 200);
    expect(cut.length).toBeLessThanOrEqual(200);
    expect(
      pickPassage('[Link text](https://x.test) and ![img](y.png) are clean words of a paragraph here.', [
        'link',
      ]),
    ).toBe('Link text and are clean words of a paragraph here.');
  });
});

function page(overrides: Partial<SessionPage> = {}): SessionPage {
  return {
    open: async (url) => ({ kind: 'page', url, status: 200, contentType: 'text/html' }),
    title: async () => 'Browser title',
    text: async () => LONG('Browser page'),
    fetchInPage: async () => {
      throw new Error('unused');
    },
    requestWithHeaders: async () => {
      throw new Error('unused');
    },
    ...overrides,
  };
}

describe('runWebResearch', () => {
  test('parallel searches, site pages first, numbered sources with passages', async () => {
    const searches: string[] = [];
    const reads: string[] = [];
    __setWebResearchDepsForTest({
      searchWeb: async (query): Promise<WebSearchHit[]> => {
        searches.push(query);
        if (query.includes('site:')) return [{ title: 'IRS W-9', url: 'https://www.irs.gov/w9' }];
        return [
          { title: 'Blog', url: 'https://blog.example/w9' },
          { title: 'IRS W-9 again', url: 'https://irs.gov/w9/' },
          { title: 'Facebook', url: 'https://facebook.com/post' },
          { title: 'Private', url: 'http://10.0.0.1/x' },
        ];
      },
      readPage: async (url): Promise<PageRead> => {
        reads.push(url);
        return { url, contentType: 'text/markdown', content: LONG(url) };
      },
    });
    const result = await runWebResearch({
      question: 'What is the current revision of Form W-9?',
      queries: ['W-9 revision', ' W-9 revision ', 'form w-9 march'],
      sites: ['https://www.irs.gov/'],
    });
    expect(searches).toEqual(['W-9 revision', 'form w-9 march', 'W-9 revision site:irs.gov']);
    expect(reads).toEqual(['https://www.irs.gov/w9', 'https://blog.example/w9', 'https://facebook.com/post']);
    expect(result.ok).toBe(true);
    expect(result.sources.map((source) => [source.n, source.title, source.url])).toEqual([
      [1, 'IRS W-9', 'https://www.irs.gov/w9'],
      [2, 'Blog', 'https://blog.example/w9'],
      [3, 'Facebook', 'https://facebook.com/post'],
    ]);
    expect(result.sources[0].passage).toContain('March 2024');
    expect(result.failed).toEqual([]);
  });

  test('thin pages go to one browser session; a signed-in site uses the saved sign-ins', async () => {
    const sessions: unknown[] = [];
    __setWebResearchDepsForTest({
      searchWeb: async () => [
        { title: 'Payroll', url: 'https://pay.example/statements' },
        { title: 'App', url: 'https://app.example/' },
        { title: 'Down', url: 'https://down.example/' },
        { title: 'Gone', url: 'https://gone.example/' },
        { title: 'File', url: 'https://file.example/' },
      ],
      readPage: async (url): Promise<PageRead> => {
        if (url.includes('pay.'))
          return {
            url,
            contentType: 'text/markdown',
            content: 'Please sign in to continue to your account.',
            status: 200,
          };
        if (url.includes('app.'))
          return {
            url,
            contentType: 'text/markdown',
            content: 'You need to enable JavaScript to run this app.',
          };
        if (url.includes('down.'))
          throw new BrowserbaseRequestError('Browserbase /fetch failed (403): blocked', 403);
        if (url.includes('gone.'))
          return { url, contentType: 'text/markdown', content: 'Not found', status: 404 };
        throw new BrowserbaseRequestError('Browserbase /fetch failed (502): big', 502);
      },
      savedContextId: async (userId) => (userId === 'u1' ? 'ctx-1' : null),
      withShortSession: (async (input: any, task: any) => {
        sessions.push(input.contextId ?? null);
        return task(
          page({
            open: async (url) =>
              url.includes('file.')
                ? { kind: 'download', filename: 'a.pdf', url }
                : { kind: 'page', url, status: 200, contentType: 'text/html' },
          }),
          's',
        );
      }) as any,
    });
    const result = await runWebResearch({
      question: 'pay statement for September',
      queries: ['pay statement'],
      sites: ['pay.example'],
      userId: 'u1',
    });
    expect(sessions.sort()).toEqual(['ctx-1', null].sort() as any);
    expect(result.sources.map((source) => [source.url, source.signedIn ?? false, source.title])).toEqual([
      ['https://pay.example/statements', true, 'Browser title'],
      ['https://app.example/', false, 'Browser title'],
      ['https://down.example/', false, 'Browser title'],
    ]);
    // Three browser pages at most: the fifth page is over the limit.
    expect(result.failed).toEqual([
      'https://gone.example/: the site answered 404',
      'https://file.example/: over the browser page limit',
    ]);
  });

  test('a failed search, a read error, an empty page, and a session error show in failed', async () => {
    __setWebResearchDepsForTest({
      searchWeb: async (query) => {
        if (query === 'broken') throw new BrowserbaseRequestError('Browserbase /search failed (500): x', 500);
        return [
          { title: 'Bad', url: 'https://bad.example/' },
          { title: 'Empty', url: 'https://empty.example/' },
          { title: 'Js', url: 'https://js.example/' },
        ];
      },
      readPage: async (url): Promise<PageRead> => {
        if (url.includes('bad.')) throw new Error('This address gives a image/png file, not text.\nmore');
        if (url.includes('empty.'))
          return { url, contentType: 'text/markdown', content: 'menu item\n'.repeat(60) };
        return { url, contentType: 'text/markdown', content: 'short' };
      },
      withShortSession: (async () => {
        throw new Error('session failed');
      }) as any,
    });
    const result = await runWebResearch({ question: 'q?', queries: ['broken', 'fine'] });
    expect(result.sources).toEqual([]);
    expect(result.failed).toEqual([
      'search "broken": the reader answered 500',
      'https://bad.example/: This address gives a image/png file, not text.',
      'https://js.example/: session failed',
      'https://empty.example/: the page has no text',
    ]);
  });

  test('a browser page with no text, a browser open error, and a time limit', async () => {
    const controller = new AbortController();
    __setWebResearchDepsForTest({
      searchWeb: async () => [
        { title: 'A', url: 'https://a.example/' },
        { title: 'B', url: 'https://b.example/' },
      ],
      readPage: async (url) => ({ url, contentType: 'text/markdown', content: '' }),
      withShortSession: (async (_input: any, task: any) =>
        task(
          page({
            text: async () => '   ',
            open: async (url) => {
              if (url.includes('b.')) {
                controller.abort(new DOMException('late', 'TimeoutError'));
                throw new DOMException('late', 'TimeoutError');
              }
              return { kind: 'page', url, status: 200, contentType: 'text/html' };
            },
          }),
          's',
        )) as any,
    });
    const result = await runWebResearch({ question: 'q?', queries: ['q'], signal: controller.signal });
    expect(result.failed).toEqual([
      'https://a.example/: the page has no text',
      'https://b.example/: no answer in time',
    ]);
  });
});
