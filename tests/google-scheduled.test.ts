import { afterEach, describe, expect, test } from 'bun:test';
import {
  __setGoogleScheduledDepsForTest,
  cancelGoogleScheduledSend,
  findGoogleScheduledSend,
  listGoogleScheduledSends,
  nylasScheduledMessage,
  outboxPayloadFromSendRequest,
  recipientsToString,
  scheduledStatusCode,
  scheduleGoogleSend,
} from '../lib/google/scheduled';
import { emailList } from '../lib/nylas/normalize';

const CREDENTIALS = { userId: 'user-1', accountId: 'acct-1' };

afterEach(() => __setGoogleScheduledDepsForTest());

describe('outbox payload of a scheduled send', () => {
  test('recipients survive the emailList parse of the dispatch', () => {
    const text = recipientsToString([
      { name: 'Ann Lee', email: 'ann@x.org' },
      { name: 'Lee, Bo', email: 'bo@x.org' },
      { email: 'cy@x.org' },
      { name: 'no email' },
    ]);
    expect(text).toBe('Ann Lee <ann@x.org>, bo@x.org, cy@x.org');
    expect(emailList(text)).toEqual([
      { name: 'Ann Lee', email: 'ann@x.org' },
      { email: 'bo@x.org' },
      { email: 'cy@x.org' },
    ]);
    expect(recipientsToString([])).toBeUndefined();
  });

  test('an HTML body, a reply target, and attachments become the sendNylasMessage payload', async () => {
    async function* stream() {
      yield Buffer.from('st');
      yield 'ream';
    }
    const payload = await outboxPayloadFromSendRequest(CREDENTIALS, {
      to: [{ email: 'ann@x.org' }],
      cc: [{ name: 'Bo', email: 'bo@x.org' }],
      subject: 'Later',
      body: '<p>hi</p>',
      isPlaintext: false,
      replyToMessageId: 'parent-1',
      attachments: [
        { filename: 'a.txt', contentType: 'text/plain', size: 2, content: Buffer.from('hi') },
        {
          filename: 'b.txt',
          contentType: 'text/plain',
          size: 6,
          content: stream(),
          contentId: 'b',
          isInline: true,
        },
        { filename: 'c.txt', contentType: 'text/plain', size: 1, content: 'Yw==' },
      ],
    });
    expect(payload).toEqual({
      userId: 'user-1',
      account: 'acct-1',
      to: 'ann@x.org',
      cc: 'Bo <bo@x.org>',
      bcc: undefined,
      subject: 'Later',
      body: '<p>hi</p>',
      html: '<p>hi</p>',
      replyToMessageId: 'parent-1',
      attachments: [
        { filename: 'a.txt', contentType: 'text/plain', size: 2, content: 'aGk=' },
        {
          filename: 'b.txt',
          contentType: 'text/plain',
          size: 6,
          contentId: 'b',
          isInline: true,
          content: 'c3RyZWFt',
        },
        { filename: 'c.txt', contentType: 'text/plain', size: 1, content: 'Yw==' },
      ],
    } as any);
  });

  test('a plain body has no html, and unknown content is refused', async () => {
    const payload = await outboxPayloadFromSendRequest(CREDENTIALS, {
      to: [],
      body: 'hi',
      isPlaintext: true,
    });
    expect(payload.html).toBeUndefined();
    expect(payload.to).toBe('');
    // The snake_case fields that the adapter send takes hold the same way.
    const snake = await outboxPayloadFromSendRequest(CREDENTIALS, {
      to: [{ email: 'a@x.org' }],
      body: 'line one\nline two',
      is_plaintext: true,
      reply_to_message_id: 'parent-2',
    });
    expect(snake.html).toBeUndefined();
    expect(snake.body).toBe('line one\nline two');
    expect(snake.replyToMessageId).toBe('parent-2');
    await expect(
      outboxPayloadFromSendRequest(CREDENTIALS, { attachments: [{ filename: 'x', content: 42 }] }),
    ).rejects.toThrow('cannot be held');
  });
});

describe('scheduleGoogleSend', () => {
  test('uploads the payload, then enqueues it with the fire time', async () => {
    const mutations: Array<{ args: any }> = [];
    const uploads: any[] = [];
    __setGoogleScheduledDepsForTest({
      mutate: (async (_fn: unknown, args: any) => {
        mutations.push({ args });
        if (mutations.length === 1) return 'https://convex.example/upload';
        return { key: args.key, fireAt: args.fireAt, status: 'pending' };
      }) as any,
      fetch: async (url: string, init?: RequestInit) => {
        uploads.push({ url, body: JSON.parse(String(init?.body)) });
        return Response.json({ storageId: 'storage-1' });
      },
      newKey: () => 'outbox:00000000-0000-0000-0000-00000000000a',
    });
    const receipt = await scheduleGoogleSend(
      CREDENTIALS,
      { to: [{ email: 'a@x.org' }], subject: 's', body: 'b' },
      1_900_000_000_000,
    );
    expect(receipt).toEqual({
      key: 'outbox:00000000-0000-0000-0000-00000000000a',
      fireAt: 1_900_000_000_000,
    });
    expect(uploads[0].url).toBe('https://convex.example/upload');
    expect(uploads[0].body).toMatchObject({ userId: 'user-1', account: 'acct-1', to: 'a@x.org', html: 'b' });
    expect(mutations[1].args).toEqual({
      userId: 'user-1',
      accountId: 'acct-1',
      key: 'outbox:00000000-0000-0000-0000-00000000000a',
      payloadId: 'storage-1',
      fireAt: 1_900_000_000_000,
    });
  });

  test('a failed upload schedules nothing', async () => {
    let enqueued = false;
    __setGoogleScheduledDepsForTest({
      mutate: (async (_fn: unknown, args: any) => {
        if (args.key) enqueued = true;
        return 'https://convex.example/upload';
      }) as any,
      fetch: async () => new Response('no', { status: 500 }),
    });
    await expect(scheduleGoogleSend(CREDENTIALS, {}, 1)).rejects.toThrow('Nothing was scheduled');
    expect(enqueued).toBe(false);
  });
});

describe('scheduled rows', () => {
  test('list, find (only for the same account), and cancel', async () => {
    const rows: Record<string, any> = {
      'outbox:1': { key: 'outbox:1', accountId: 'acct-1', fireAt: 5000, status: 'pending' },
      'outbox:2': { key: 'outbox:2', accountId: 'acct-2', fireAt: 6000, status: 'pending' },
    };
    const cancelled: string[] = [];
    __setGoogleScheduledDepsForTest({
      query: (async (_fn: unknown, args: any) =>
        args.key ? (rows[args.key] ?? null) : [rows['outbox:1']]) as any,
      mutate: (async (_fn: unknown, args: any) => {
        cancelled.push(args.key);
        return true;
      }) as any,
    });
    expect(await listGoogleScheduledSends(CREDENTIALS)).toEqual([rows['outbox:1']]);
    expect(await findGoogleScheduledSend(CREDENTIALS, 'outbox:1')).toEqual(rows['outbox:1']);
    expect(await findGoogleScheduledSend(CREDENTIALS, 'outbox:2')).toBeNull();
    expect(await cancelGoogleScheduledSend(CREDENTIALS, 'outbox:2')).toBe(false);
    expect(await cancelGoogleScheduledSend(CREDENTIALS, 'outbox:1')).toBe(true);
    expect(cancelled).toEqual(['outbox:1']);
    __setGoogleScheduledDepsForTest({ query: (async () => null) as any });
    expect(await listGoogleScheduledSends(CREDENTIALS)).toEqual([]);
  });

  test('outbox states map to the Nylas status codes that the app reads', () => {
    expect(['pending', 'sending', 'sent', 'failed', 'cancelled', 'unknown'].map(scheduledStatusCode)).toEqual(
      ['pending', 'close_to_send_time', 'success', 'failed', 'cancelled', 'pending'],
    );
    expect(nylasScheduledMessage({ key: 'outbox:1', fireAt: 1_900_000_000_999, status: 'sending' })).toEqual({
      scheduleId: 'outbox:1',
      status: { code: 'close_to_send_time', description: 'The scheduled message is close to send time.' },
      closeTime: 1_900_000_000,
    });
  });
});
