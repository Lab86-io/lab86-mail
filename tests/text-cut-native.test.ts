import { afterEach, describe, expect, mock, test } from 'bun:test';
import { __setChatUploadDepsForTest, hydrateChatAttachments } from '../lib/ai/chat-upload-content';
import { normalizeCalendarCorpusText } from '../lib/calendar/corpus';
import { toEventInput } from '../lib/calendar/sync';
import { uniqueWorksheetName } from '../lib/documents/export';
import { applyCopyRepairs } from '../lib/documents/presentation-design';
import { excerpt } from '../lib/documents/presentation-review';
import { documentPreviewPages } from '../lib/documents/preview';
import { __setDocumentServiceDepsForTest, createDocument } from '../lib/documents/service';
import type { SyncConnectionDeps } from '../lib/mcp/sync';
import { syncConnection } from '../lib/mcp/sync';
import { mailThreadSummaryFromCorpus } from '../lib/mobile/v1/mail-reads';
import { buildAPNsPayload } from '../lib/notifications/apns';
import { dispatchNativeNotification } from '../lib/notifications/native-delivery';
import { searchIndexedContent } from '../lib/search/global-search';
import { lakeshoreBrief } from './fixtures/presentation-briefs';

// An emoji is two UTF-16 code units. Each input below puts one across a cap,
// so a plain `.slice` would leave a lone surrogate: invalid JSON for APNs,
// Swift's JSONDecoder, Convex and model providers.
const EMOJI = '\u{1F600}';
const HIGH = EMOJI[0];
const LOW = EMOJI[1];
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const across = (index: number, tail = 'tail') => `${'x'.repeat(index - 1)}${EMOJI}${tail}`;

function expectValidJson(value: unknown) {
  const json = JSON.stringify(value);
  // JSON.stringify escapes only lone surrogates; a whole emoji stays literal.
  expect(json).not.toMatch(/\\ud[89a-f][0-9a-f]{2}/i);
  if (typeof value === 'string') expect(LONE.test(value)).toBe(false);
}

afterEach(() => {
  __setChatUploadDepsForTest();
  __setDocumentServiceDepsForTest();
});

describe('native payloads keep whole emoji at their caps', () => {
  test('the APNs payload cuts the alert title and body on a whole emoji', () => {
    const payload = buildAPNsPayload({
      id: 'notice-1',
      userId: 'user-1',
      title: across(180, ' and more'),
      body: across(1_000, ' and more'),
      deepLink: '/activity',
    } as any);
    expect(payload.aps.alert.title).toBe('x'.repeat(179));
    expect(payload.aps.alert.body).toBe('x'.repeat(999));
    expectValidJson(payload);
    const short = buildAPNsPayload({
      id: 'notice-2',
      userId: 'user-1',
      title: ` Trip ${EMOJI} `,
      body: 'Plain body',
      deepLink: '/activity',
    } as any);
    expect(short.aps.alert).toEqual({ title: `Trip ${EMOJI}`, body: 'Plain body' });
  });

  test('a failed native delivery stores a whole-emoji error', async () => {
    const mutations: Array<Record<string, unknown>> = [];
    const result = await dispatchNativeNotification('user-1', 'notice-1', {
      query: async () => ({
        notification: {
          _id: 'notice-1',
          title: 'T',
          body: 'B',
          deepLink: '/activity',
          type: 'work_question',
        },
        mobileDevices: [{ token: 'aa'.repeat(32), environment: 'production' }],
        deliveries: [],
        nativeDeviceDeliveries: [],
        preference: null,
      }),
      mutate: async (_fn: unknown, args: Record<string, unknown>) => {
        mutations.push(args);
        return null;
      },
      send: async () => {
        throw new Error(across(500, ' provider detail'));
      },
    } as any);
    expect(result).toEqual({ sent: 0, failed: 1 });
    const delivery = mutations.find((args) => args.channel === 'native_push');
    expect(delivery?.error).toBe('x'.repeat(499));
    expectValidJson(delivery);
  });

  test('the mobile mail summary caps subject and snippet on a whole emoji and cleans lone halves', () => {
    const summary = mailThreadSummaryFromCorpus({
      _id: 'thread-1',
      account: 'account-1',
      subject: across(2_000),
      fromAddress: `Maya ${HIGH} <maya@example.com>`,
      snippet: across(500),
      lastDate: 1_000,
      labels: [`Trips${LOW}`],
    });
    expect(summary.subject).toBe('x'.repeat(1_999));
    expect(summary.snippet).toBe('x'.repeat(499));
    expect(summary.fromHeader).toBe('Maya \uFFFD <maya@example.com>');
    expect(summary.labels).toEqual(['Trips\uFFFD']);
    expectValidJson(summary);
    expect(
      mailThreadSummaryFromCorpus({ _id: 't', account: 'a', subject: `Hi ${EMOJI}`, snippet: 'ok' }),
    ).toMatchObject({
      subject: `Hi ${EMOJI}`,
      snippet: 'ok',
    });
  });
});

describe('search, chat uploads and documents keep whole emoji at their caps', () => {
  test('indexed search detail and chat attachment excerpts', async () => {
    const fetcher = (async () =>
      Response.json({
        items: [
          {
            _id: 'c1',
            source: 'notion',
            connectionId: 'n',
            externalId: 'e1',
            title: 'Launch notes',
            text: across(200),
            url: 'https://example.com/launch',
            modifiedAt: 1,
            partial: false,
          },
        ],
      })) as unknown as typeof fetch;
    const group = await searchIndexedContent('launch', false, undefined, fetcher);
    expect(group.items[0].detail).toBe(`notion · ${'x'.repeat(199)}`);
    expectValidJson(group);

    const text = `${across(80_000)} ${HIGH}`;
    const output = await hydrateChatAttachments('owner', [
      {
        id: 'm',
        role: 'user',
        parts: [
          {
            type: 'file',
            filename: 'notes.txt',
            mediaType: 'text/plain',
            url: `data:text/plain;base64,${Buffer.from(text).toString('base64')}`,
          },
        ],
      },
    ] as any);
    const part = (output[0].parts[0] as any).text as string;
    expect(part).toContain(`${'x'.repeat(79_999)}\n[Excerpt truncated at 80,000 characters.]`);
    expectValidJson(part);
  });

  test('document titles, sheet names, copy repairs, excerpts and previews', async () => {
    const mutation = mock(async (_reference: unknown, input: any) => ({ ...input, currentRevision: 1 }));
    __setDocumentServiceDepsForTest({
      convexMutation: mutation as any,
      randomUUID: (() => 'document-1') as any,
    });
    const created = await createDocument({ userId: 'user-1', kind: 'doc', title: across(500) });
    expect(created.title).toBe('x'.repeat(499));

    expect(uniqueWorksheetName(across(31), new Set())).toBe('x'.repeat(30));
    // A taken name gets a numbered marker; the shorter cut keeps the emoji whole.
    const taken = `${'x'.repeat(26)}${EMOJI}yyy`;
    expect(uniqueWorksheetName(taken, new Set([taken.toLocaleLowerCase('en-US')]))).toBe(
      `${'x'.repeat(26)} (2)`,
    );

    const repaired = applyCopyRepairs(
      lakeshoreBrief(),
      ['slide-1'],
      [
        { slideId: 'slide-1', field: 'title', text: across(120) },
        { slideId: 'slide-1', field: 'kicker', text: across(40) },
      ],
    );
    expect(repaired.slides[0].title).toBe('x'.repeat(119));
    expect(repaired.slides[0].kicker).toBe('x'.repeat(39));

    expectValidJson(excerpt(across(59, 'x'.repeat(40)), 60));
    const [page] = documentPreviewPages({
      kind: 'doc',
      blocks: [{ id: 'b1', type: 'paragraph', text: across(400) }],
    });
    expect((page as any).blocks[0].text).toBe('x'.repeat(399));
  });
});

describe('provider text is cleaned where it enters the system', () => {
  test('calendar events and calendar search text', () => {
    const event = toEventInput(
      {
        id: 'event-1',
        calendarId: 'calendar-1',
        title: `Dinner ${HIGH}`,
        description: `${LOW}Bring wine ${EMOJI}`,
        location: 'Home',
        when: { startTime: 1_790_000_000, endTime: 1_790_003_600 },
        participants: [{ name: `Ari ${HIGH}`, email: 'ari@example.com' }],
      },
      undefined,
      'Personal',
    );
    expect(event?.title).toBe('Dinner \uFFFD');
    expect(event?.description).toBe(`\uFFFDBring wine ${EMOJI}`);
    expect((event?.participants as any)[0].name).toBe('Ari \uFFFD');
    expectValidJson(event);
    expect(normalizeCalendarCorpusText(across(16_000))).toBe('x'.repeat(15_999));
  });

  test('MCP and REST connector items before the Convex upsert', async () => {
    const batches: any[] = [];
    const deps = {
      getConnectionToken: async () => ({
        row: {
          connectionId: 'github_conn',
          server: 'github',
          serverUrl: 'https://api.github.com',
          authKind: 'token',
          status: 'connected',
          scopes: [],
          includeInBrief: true,
          includeInSearch: true,
        },
        token: 'ghp_123',
      }),
      listUserConnections: async () => [],
      convexMutation: async (_fn: unknown, args: any) => {
        if (args.items) batches.push(args.items);
        return undefined;
      },
      loadBitbucketItems: async () => ({ items: [] }),
      loadGitHubItems: async () => ({
        viewer: 'octocat',
        items: [
          {
            externalId: 'github:issue:lab86/mail#1',
            kind: 'issue',
            title: `Fix ${HIGH}`,
            summary: `Plan ${EMOJI}`,
            raw: { labels: [{ name: `${LOW}bug` }] },
            searchText: `Fix ${HIGH} issue`,
          },
        ],
      }),
      connectMcp: async () => {
        throw new Error('connectMcp should not be called');
      },
      callMcpTool: async () => {
        throw new Error('callMcpTool should not be called');
      },
    } as unknown as SyncConnectionDeps;
    expect(await syncConnection('user_1', 'github_conn', deps)).toEqual({ ok: true, count: 1 });
    const [item] = batches.flat();
    expect(item).toMatchObject({
      title: 'Fix \uFFFD',
      summary: `Plan ${EMOJI}`,
      raw: { labels: [{ name: '\uFFFDbug' }] },
      searchText: 'Fix \uFFFD issue',
    });
    expectValidJson(batches);
  });
});
