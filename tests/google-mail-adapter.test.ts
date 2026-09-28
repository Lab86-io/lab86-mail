import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  __setGoogleMailAdapterDepsForTest,
  gmailListQuery,
  googleMailAdapter,
  labelDelta,
} from '../lib/google/adapter/mail';
import { encodeAttachmentId } from '../lib/google/gmail-message';
import { __setGoogleHttpDepsForTest, GoogleApiError } from '../lib/google/http';
import { routeNylasClient } from '../lib/nylas/client';
import {
  b64url,
  filePart,
  h,
  multipart,
  plainMessage,
  receiptMessage,
  textPart,
} from './google-gmail-fixtures';

const GRANT = 'google:acct-1';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

type Handler = (call: { url: URL; method: string; body: any; raw: string }) => {
  status?: number;
  json?: unknown;
};

interface FakeGmail {
  calls: Array<{
    method: string;
    path: string;
    search: URLSearchParams;
    body: any;
    raw: string;
    contentType: string;
  }>;
  on: (method: string, path: RegExp, handler: Handler) => void;
}

function fakeGmail(): FakeGmail {
  const routes: Array<{ method: string; path: RegExp; handler: Handler }> = [];
  const gmail: FakeGmail = {
    calls: [],
    on: (method, path, handler) => routes.push({ method, path, handler }),
  };
  __setGoogleHttpDepsForTest({
    getGoogleAccessToken: async () => 'token',
    invalidateGoogleAccessToken: () => {},
    sleep: async () => {},
    fetch: async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      const method = init?.method || 'GET';
      const raw = typeof init?.body === 'string' ? init.body : '';
      let body: any = raw;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {}
      gmail.calls.push({
        method,
        path: url.pathname,
        search: url.searchParams,
        body,
        raw,
        contentType: new Headers(init?.headers).get('content-type') || '',
      });
      const route = routes.find((entry) => entry.method === method && entry.path.test(url.pathname));
      if (!route) return new Response(JSON.stringify({ error: { message: 'Not Found' } }), { status: 404 });
      const result = route.handler({ url, method, body, raw });
      return new Response(result.json === undefined ? null : JSON.stringify(result.json), {
        status: result.status ?? 200,
      });
    },
  });
  return gmail;
}

const CREDENTIALS = {
  userId: 'user-1',
  accountId: 'acct-1',
  email: 'ann@example.com',
  scopes: ['https://www.googleapis.com/auth/gmail.modify'],
  refreshTokenEncrypted: 'enc(refresh)',
  previousNylasGrantId: 'nylas-grant-1',
};

let gmail: FakeGmail;
let adapterCalls: Record<string, any[]>;

beforeEach(() => {
  gmail = fakeGmail();
  adapterCalls = { schedule: [], cancel: [], revoke: [], removeGrant: [], destroyNylas: [] };
  __setGoogleMailAdapterDepsForTest({
    loadCredentials: async () => CREDENTIALS,
    decryptSecret: (value: string) => value.replace(/^enc\((.*)\)$/, '$1'),
    revokeGoogleToken: async (token: string) => {
      adapterCalls.revoke.push(token);
      return true;
    },
    mutate: (async (_fn: unknown, args: any) => {
      adapterCalls.removeGrant.push(args);
      return { removed: 1, previousNylasGrantIds: ['nylas-grant-1'] };
    }) as any,
    destroyNylasGrant: async (grantId: string) => {
      adapterCalls.destroyNylas.push(grantId);
    },
    scheduleGoogleSend: (async (credentials: any, body: any, fireAt: number) => {
      adapterCalls.schedule.push({ credentials, body, fireAt });
      return { key: 'outbox:00000000-0000-0000-0000-000000000001', fireAt };
    }) as any,
    listGoogleScheduledSends: async () => [
      { key: 'outbox:1', fireAt: 1_800_000_060_000, status: 'pending' },
      { key: 'outbox:2', fireAt: 1_800_000_000_000, status: 'sent' },
    ],
    findGoogleScheduledSend: (async (_c: any, key: string) =>
      key === 'outbox:1' ? { key, fireAt: 1_800_000_060_000, status: 'sending' } : null) as any,
    cancelGoogleScheduledSend: (async (_c: any, key: string) => {
      adapterCalls.cancel.push(key);
      return key === 'outbox:1';
    }) as any,
    boundary: () => 'UPLOAD',
    now: () => 1_800_000_000_000,
    sleep: async () => {},
  });
});

afterEach(() => {
  __setGoogleHttpDepsForTest();
  __setGoogleMailAdapterDepsForTest();
});

const messages = googleMailAdapter.messages!;
const threads = googleMailAdapter.threads!;
const folders = googleMailAdapter.folders!;

describe('list query mapping', () => {
  test('Nylas filters become a Gmail q, label ids, and the spam and trash switch', () => {
    expect(
      gmailListQuery({
        received_after: 1700000000,
        receivedBefore: '1800000000',
        unread: true,
        starred: false,
        has_attachment: true,
        from: 'bob@x.org',
        subject: 'big plans',
        any_email: ['a@x.org'],
        in: ['INBOX', 'Label_1'],
      }),
    ).toEqual({
      q: 'after:1700000000 before:1800000000 is:unread -is:starred has:attachment from:bob@x.org subject:"big plans" {from:a@x.org to:a@x.org cc:a@x.org bcc:a@x.org}',
      labelIds: ['INBOX', 'Label_1'],
      includeSpamTrash: true,
    });
    expect(
      gmailListQuery({
        search_query_native: 'in:inbox newer_than:7d',
        unread: 'false',
        starred: 'true',
        in: 'SENT',
      }),
    ).toEqual({
      q: 'in:inbox newer_than:7d -is:unread is:starred',
      labelIds: ['SENT'],
      includeSpamTrash: false,
    });
    expect(gmailListQuery()).toEqual({ q: undefined, labelIds: [], includeSpamTrash: true });
  });

  test('label deltas follow Nylas folder sets but keep flags and fixed labels', () => {
    expect(
      labelDelta(['INBOX', 'UNREAD', 'CATEGORY_UPDATES', 'SENT'], { folders: ['CATEGORY_UPDATES', 'TRASH'] }),
    ).toEqual({
      addLabelIds: ['TRASH'],
      removeLabelIds: ['INBOX'],
    });
    expect(labelDelta(['INBOX', 'UNREAD'], { unread: false, starred: true })).toEqual({
      addLabelIds: ['STARRED'],
      removeLabelIds: ['UNREAD'],
    });
    expect(labelDelta(['INBOX'], { unread: true, folders: ['INBOX', 'DRAFT'] })).toEqual({
      addLabelIds: ['UNREAD'],
      removeLabelIds: [],
    });
    expect(labelDelta(['STARRED'], { starred: false, folders: ['STARRED'] })).toEqual({
      addLabelIds: [],
      removeLabelIds: ['STARRED'],
    });
    expect(labelDelta([], {})).toEqual({ addLabelIds: [], removeLabelIds: [] });
  });
});

describe('messages', () => {
  test('list reads ids, then each message, and keeps the Nylas page shape', async () => {
    gmail.on('GET', /\/messages$/, () => ({
      json: { messages: [{ id: 'm1' }, { id: 'gone' }, { id: 'draft' }], nextPageToken: 'next-1' },
    }));
    gmail.on('GET', /\/messages\/m1$/, () => ({ json: receiptMessage({ id: 'm1', threadId: 't1' }) }));
    gmail.on('GET', /\/messages\/draft$/, () => ({
      json: plainMessage({ id: 'draft', labelIds: ['DRAFT'] }),
    }));
    const page = await messages.list({
      identifier: GRANT,
      queryParams: { limit: 20, page_token: 'p0', receivedAfter: 1700000000 },
    });
    expect(page.nextCursor).toBe('next-1');
    expect(page.data.map((m: any) => m.id)).toEqual(['m1']);
    expect(page.data[0].headers).toBeUndefined();
    const list = gmail.calls[0];
    expect(list.search.get('maxResults')).toBe('20');
    expect(list.search.get('pageToken')).toBe('p0');
    expect(list.search.get('q')).toBe('after:1700000000');
    expect(list.search.get('includeSpamTrash')).toBe('true');
    expect(
      gmail.calls
        .filter((c) => c.path.includes('/messages/'))
        .every((c) => c.search.get('format') === 'full'),
    ).toBe(true);
  });

  test('a message read that fails for another reason than 404 fails the list', async () => {
    gmail.on('GET', /\/messages$/, () => ({ json: { messages: [{ id: 'm1' }] } }));
    gmail.on('GET', /\/messages\/m1$/, () => ({
      status: 500,
      json: { error: { message: 'Backend Error' } },
    }));
    const error = (await messages
      .list({ identifier: GRANT, queryParams: {} })
      .catch((e: unknown) => e)) as GoogleApiError;
    expect(error.statusCode).toBe(500);
  });

  test('a bad page token names page_token, so the backfill restarts', async () => {
    gmail.on('GET', /\/messages$/, () => ({
      status: 400,
      json: { error: { message: 'Invalid pageToken' } },
    }));
    const error = (await messages
      .list({ identifier: GRANT, queryParams: { page_token: 'stale' } })
      .catch((e: unknown) => e)) as GoogleApiError;
    expect(error.statusCode).toBe(400);
    expect(error.message).toContain('page_token');
    const plain = (await messages
      .list({ identifier: GRANT, queryParams: {} })
      .catch((e: unknown) => e)) as GoogleApiError;
    expect(plain.message).toBe('Invalid pageToken');
  });

  test('list by thread reads the thread, newest first, without drafts', async () => {
    gmail.on('GET', /\/threads\/t1$/, () => ({
      json: {
        id: 't1',
        messages: [
          plainMessage({ id: 'a', threadId: 't1', internalDate: '1000' }),
          plainMessage({ id: 'b', threadId: 't1', internalDate: '5000' }),
          plainMessage({ id: 'c', threadId: 't1', internalDate: '9000', labelIds: ['DRAFT'] }),
        ],
      },
    }));
    const page = await messages.list({
      identifier: GRANT,
      queryParams: { threadId: 't1', limit: 200, fields: 'include_headers' },
    });
    expect(page.data.map((m: any) => m.id)).toEqual(['b', 'a']);
    expect(page.data[0].headers.length).toBeGreaterThan(0);
    expect(await messages.list({ identifier: GRANT, queryParams: { thread_id: 'missing' } })).toEqual({
      data: [],
      requestId: 'google-direct',
    });
  });

  test('find returns one message, with headers when asked', async () => {
    gmail.on('GET', /\/messages\/m1$/, () => ({ json: receiptMessage({ id: 'm1' }) }));
    const found = await messages.find({
      identifier: GRANT,
      messageId: 'm1',
      queryParams: { fields: 'include_headers' },
    });
    expect(found.data.id).toBe('m1');
    expect(found.data.headers.some((header: any) => header.name === 'List-Unsubscribe')).toBe(true);
    const missing = (await messages
      .find({ identifier: GRANT, messageId: 'nope' })
      .catch((e: unknown) => e)) as GoogleApiError;
    expect(missing.statusCode).toBe(404);
  });

  test('update reads the labels for a folder set and sends one modify', async () => {
    gmail.on('GET', /\/messages\/m1$/, () => ({
      json: { id: 'm1', threadId: 't1', labelIds: ['INBOX', 'UNREAD'] },
    }));
    gmail.on('POST', /\/messages\/m1\/modify$/, ({ body }) => ({
      json: {
        id: 'm1',
        threadId: 't1',
        labelIds: ['TRASH', ...body.addLabelIds.filter((l: string) => l !== 'TRASH')],
      },
    }));
    const result = await messages.update({
      identifier: GRANT,
      messageId: 'm1',
      requestBody: { folders: ['TRASH', 'UNREAD'], unread: false },
    });
    const modify = gmail.calls.find((call) => call.path.endsWith('/modify'));
    expect(modify?.body).toEqual({ addLabelIds: ['TRASH'], removeLabelIds: ['INBOX', 'UNREAD'] });
    expect(result.data.folders).toEqual(['TRASH']);
  });

  test('an update that changes nothing sends no modify', async () => {
    gmail.on('GET', /\/messages\/m1$/, () => ({ json: { id: 'm1', threadId: 't1', labelIds: ['INBOX'] } }));
    const result = await messages.update({
      identifier: GRANT,
      messageId: 'm1',
      requestBody: { unread: false },
    });
    expect(gmail.calls.some((call) => call.path.endsWith('/modify'))).toBe(false);
    expect(result.data.unread).toBe(false);
  });
});

describe('send', () => {
  test('a reply fetches the parent headers and sends MIME with the thread id', async () => {
    gmail.on('GET', /\/messages\/parent$/, () => ({
      json: {
        id: 'parent',
        threadId: 'thread-9',
        payload: { headers: [h('Message-ID', '<parent@x.org>'), h('References', '<root@x.org>')] },
      },
    }));
    gmail.on('POST', /\/upload\/gmail\/v1\/users\/me\/messages\/send$/, () => ({
      json: { id: 'sent-1', threadId: 'thread-9', labelIds: ['SENT'] },
    }));
    const result = await messages.send({
      identifier: GRANT,
      requestBody: {
        to: [{ name: 'Bob', email: 'bob@x.org' }],
        cc: [],
        subject: 'Re: Plans',
        body: 'Sounds good',
        isPlaintext: true,
        replyToMessageId: 'parent',
        attachments: [{ filename: 'a.txt', contentType: 'text/plain', content: Buffer.from('hi'), size: 2 }],
      },
    });
    const parentRead = gmail.calls.find((call) => call.path.endsWith('/messages/parent'));
    expect(parentRead?.search.get('format')).toBe('metadata');
    expect(parentRead?.search.getAll('metadataHeaders')).toEqual(['Message-ID', 'References']);
    const upload = gmail.calls.find((call) => call.path.endsWith('/send'));
    expect(upload?.search.get('uploadType')).toBe('multipart');
    expect(upload?.contentType).toBe('multipart/related; boundary=UPLOAD');
    expect(upload?.raw).toContain('{"threadId":"thread-9"}');
    expect(upload?.raw).toContain('Content-Type: message/rfc822');
    expect(upload?.raw).toContain('To: Bob <bob@x.org>');
    expect(upload?.raw).toContain('In-Reply-To: <parent@x.org>');
    expect(upload?.raw).toContain('References: <root@x.org> <parent@x.org>');
    expect(upload?.raw).toContain('filename="a.txt"');
    expect(result.data).toMatchObject({
      id: 'sent-1',
      threadId: 'thread-9',
      from: [{ name: '', email: 'ann@example.com' }],
      to: [{ name: 'Bob', email: 'bob@x.org' }],
      folders: ['SENT'],
      date: 1_800_000_000,
    });
  });

  test('a send is not retried after a server error, so it cannot go out twice', async () => {
    gmail.on('POST', /\/messages\/send$/, () => ({
      status: 500,
      json: { error: { message: 'Backend Error' } },
    }));
    const error = (await messages
      .send({
        identifier: GRANT,
        requestBody: { to: [{ email: 'a@x.org' }], subject: 's', body: '<p>b</p>' },
      })
      .catch((e: unknown) => e)) as GoogleApiError;
    expect(error.statusCode).toBe(500);
    expect(gmail.calls.filter((call) => call.path.endsWith('/send'))).toHaveLength(1);
    expect(gmail.calls[0].raw).toContain('multipart/alternative');
  });

  test('a future send time holds the message in the outbox', async () => {
    const sendAt = 1_800_000_000 + 3600;
    const result = await messages.send({
      identifier: GRANT,
      requestBody: { to: [{ email: 'a@x.org' }], subject: 'Later', body: 'x', sendAt },
    });
    expect(gmail.calls).toEqual([]);
    expect(adapterCalls.schedule).toHaveLength(1);
    expect(adapterCalls.schedule[0].fireAt).toBe(sendAt * 1000);
    expect(adapterCalls.schedule[0].credentials.accountId).toBe('acct-1');
    expect(result.data.scheduleId).toBe('outbox:00000000-0000-0000-0000-000000000001');
    expect(result.data.date).toBe(sendAt);
  });

  test('a send time in the past sends at once', async () => {
    gmail.on('POST', /\/messages\/send$/, () => ({ json: { id: 'now-1', threadId: 'now-1' } }));
    const result = await messages.send({
      identifier: GRANT,
      requestBody: { to: [{ email: 'a@x.org' }], subject: 's', body: 'b', send_at: 1_799_999_000 },
    });
    expect(result.data.id).toBe('now-1');
    expect(result.data.folders).toEqual(['SENT']);
  });

  test('attachment content can be a stream; other content is refused', async () => {
    gmail.on('POST', /\/messages\/send$/, () => ({ json: { id: 's1', threadId: 's1' } }));
    async function* chunks() {
      yield 'str';
      yield Buffer.from('eam');
    }
    await messages.send({
      identifier: GRANT,
      requestBody: {
        to: [{ email: 'a@x.org' }],
        subject: 's',
        body: 'b',
        isPlaintext: true,
        attachments: [{ filename: 's.txt', contentType: 'text/plain', content: chunks() }],
      },
    });
    expect(gmail.calls[0].raw).toContain(Buffer.from('stream').toString('base64'));
    const refused = (await messages
      .send({ identifier: GRANT, requestBody: { to: [], attachments: [{ filename: 'x', content: 7 }] } })
      .catch((e: unknown) => e)) as GoogleApiError;
    expect(refused.statusCode).toBe(400);
  });

  test('without a token row the send needs a reconnect', async () => {
    __setGoogleMailAdapterDepsForTest({ loadCredentials: async () => null });
    const error = (await messages
      .send({ identifier: GRANT, requestBody: {} })
      .catch((e: unknown) => e)) as GoogleApiError;
    expect(error.statusCode).toBe(401);
    expect(error.reason).toBe('invalid_grant');
  });
});

describe('scheduled messages', () => {
  test('list, find, and stop read the outbox', async () => {
    const list = await messages.listScheduledMessages({ identifier: GRANT });
    expect(list.data).toEqual([
      {
        scheduleId: 'outbox:1',
        status: { code: 'pending', description: 'The scheduled message is pending.' },
        closeTime: 1_800_000_060,
      },
      {
        scheduleId: 'outbox:2',
        status: { code: 'success', description: 'The scheduled message is success.' },
        closeTime: 1_800_000_000,
      },
    ]);
    const found = await messages.findScheduledMessage({ identifier: GRANT, scheduleId: 'outbox:1' });
    expect(found.data.status.code).toBe('close_to_send_time');
    await expect(
      messages.findScheduledMessage({ identifier: GRANT, scheduleId: 'outbox:9' }),
    ).rejects.toThrow('not found');
    const stopped = await messages.stopScheduledMessage({ identifier: GRANT, scheduleId: 'outbox:1' });
    expect(stopped.data.message).toContain('cancelled');
    const late = (await messages
      .stopScheduledMessage({ identifier: GRANT, scheduleId: 'outbox:2' })
      .catch((e: unknown) => e)) as GoogleApiError;
    expect(late.statusCode).toBe(409);
    expect(adapterCalls.cancel).toEqual(['outbox:1', 'outbox:2']);
  });
});

describe('threads', () => {
  test('a native search lists threads, then reads each one as metadata', async () => {
    gmail.on('GET', /\/threads$/, () => ({
      json: { threads: [{ id: 't1', snippet: 'from the list' }, { id: 'gone' }], nextPageToken: 'tp' },
    }));
    gmail.on('GET', /\/threads\/t1$/, () => ({
      json: {
        id: 't1',
        messages: [plainMessage({ id: 'a', threadId: 't1', labelIds: ['INBOX', 'UNREAD'] })],
      },
    }));
    const page = await threads.list({
      identifier: GRANT,
      queryParams: { limit: 10, search_query_native: 'from:bob', page_token: 'p1' },
    });
    expect(page.nextCursor).toBe('tp');
    expect(page.data).toHaveLength(1);
    expect(page.data[0]).toMatchObject({
      id: 't1',
      snippet: 'from the list',
      unread: true,
      folders: ['INBOX', 'UNREAD'],
    });
    const list = gmail.calls[0];
    expect(list.search.get('q')).toBe('from:bob');
    expect(list.search.has('includeSpamTrash')).toBe(false);
    const read = gmail.calls.find((call) => call.path.endsWith('/threads/t1'));
    expect(read?.search.get('format')).toBe('metadata');
    expect(read?.search.getAll('metadataHeaders')).toEqual(['From', 'To', 'Cc', 'Subject', 'Date']);
  });

  test('find and update use the union of the message labels', async () => {
    gmail.on('GET', /\/threads\/t1$/, () => ({
      json: {
        id: 't1',
        messages: [
          { id: 'a', threadId: 't1', labelIds: ['INBOX', 'UNREAD'] },
          { id: 'b', threadId: 't1', labelIds: ['INBOX', 'Label_7'] },
        ],
      },
    }));
    gmail.on('POST', /\/threads\/t1\/modify$/, () => ({
      json: { id: 't1', messages: [{ id: 'a', threadId: 't1', labelIds: ['Label_7'] }] },
    }));
    const found = await threads.find({ identifier: GRANT, threadId: 't1' });
    expect(found.data.folders.sort()).toEqual(['INBOX', 'Label_7', 'UNREAD']);
    // Archive: the Gmail branch of folderIdsAfterMove keeps every label but INBOX and TRASH.
    const updated = await threads.update({
      identifier: GRANT,
      threadId: 't1',
      requestBody: { folders: ['UNREAD', 'Label_7'] },
    });
    const modify = gmail.calls.find((call) => call.path.endsWith('/threads/t1/modify'));
    expect(modify?.body).toEqual({ addLabelIds: [], removeLabelIds: ['INBOX'] });
    expect(updated.data.folders).toEqual(['Label_7']);
    const unchanged = await threads.update({
      identifier: GRANT,
      threadId: 't1',
      requestBody: { starred: false },
    });
    expect(unchanged.data.id).toBe('t1');
  });
});

describe('folders', () => {
  test('list is cached for a minute, and create clears the cache', async () => {
    gmail.on('GET', /\/labels$/, () => ({
      json: {
        labels: [
          { id: 'INBOX', name: 'INBOX', type: 'system' },
          { id: 'Label_1', name: 'Receipts', type: 'user' },
        ],
      },
    }));
    gmail.on('POST', /\/labels$/, ({ body }) => ({ json: { id: 'Label_2', name: body.name } }));
    const first = await folders.list({ identifier: GRANT, queryParams: { limit: 200 } });
    await folders.list({ identifier: GRANT });
    expect(first.data.map((f: any) => [f.id, f.systemFolder])).toEqual([
      ['INBOX', true],
      ['Label_1', false],
    ]);
    expect(gmail.calls.filter((call) => call.method === 'GET')).toHaveLength(1);
    const created = await folders.create({ identifier: GRANT, requestBody: { name: ' Travel ' } });
    expect(created.data).toMatchObject({ id: 'Label_2', name: 'Travel', systemFolder: false });
    expect(gmail.calls.find((call) => call.method === 'POST')?.body).toEqual({
      name: 'Travel',
      labelListVisibility: 'labelShow',
      messageListVisibility: 'show',
    });
    await folders.list({ identifier: GRANT });
    expect(gmail.calls.filter((call) => call.method === 'GET')).toHaveLength(2);
    await expect(folders.create({ identifier: GRANT, requestBody: { name: ' ' } })).rejects.toThrow(
      'label name',
    );
  });

  test('the label cache keeps at most 500 mailboxes', async () => {
    gmail.on('GET', /\/labels$/, () => ({ json: { labels: [] } }));
    for (let index = 0; index <= 500; index += 1) await folders.list({ identifier: `google:acct-${index}` });
    expect(gmail.calls).toHaveLength(501);
    // The first mailbox left the cache, so it is read again; the last one is cached.
    await folders.list({ identifier: 'google:acct-0' });
    await folders.list({ identifier: 'google:acct-500' });
    expect(gmail.calls).toHaveLength(502);
  });

  test('a label that exists gives the 409 that the callers look for', async () => {
    gmail.on('POST', /\/labels$/, () => ({
      status: 409,
      json: { error: { message: 'Label name exists or conflicts' } },
    }));
    const error = (await folders
      .create({ identifier: GRANT, requestBody: { name: 'Receipts' } })
      .catch((e: unknown) => e)) as GoogleApiError;
    expect(error.statusCode).toBe(409);
  });

  test('find reads one label with its counts', async () => {
    gmail.on('GET', /\/labels\/INBOX$/, () => ({
      json: { id: 'INBOX', name: 'INBOX', type: 'system', messagesTotal: 9 },
    }));
    expect((await folders.find({ identifier: GRANT, folderId: 'INBOX' })).data.totalCount).toBe(9);
  });
});

describe('attachments', () => {
  const STORED_ID = encodeAttachmentId({
    filename: 'Invoice-VKHXRY-00028.pdf',
    contentType: 'application/octet-stream',
    size: 42076,
  });

  test('a stored v0 id downloads the bytes of the matching part', async () => {
    gmail.on('GET', /\/messages\/m1$/, () => ({ json: receiptMessage({ id: 'm1' }) }));
    gmail.on('GET', /\/messages\/m1\/attachments\/ANGjdJ_volatile_1$/, () => ({
      json: { size: 5, data: b64url('%PDF!') },
    }));
    const stream = await googleMailAdapter.attachments!.download({
      identifier: GRANT,
      attachmentId: STORED_ID,
      queryParams: { messageId: 'm1' },
    });
    expect(await new Response(stream).text()).toBe('%PDF!');
  });

  test('an inline part is read from the message itself', async () => {
    const inline = filePart({
      filename: 'note.txt',
      contentType: 'text/plain; name=note.txt',
      size: 4,
      data: b64url('note'),
    });
    gmail.on('GET', /\/messages\/m2$/, () => ({
      json: {
        id: 'm2',
        threadId: 'm2',
        payload: multipart('multipart/mixed', [textPart('text/plain', 'x'), inline]),
      },
    }));
    const id = encodeAttachmentId({
      filename: 'note.txt',
      contentType: 'text/plain; name=note.txt',
      size: 4,
    });
    const stream = await googleMailAdapter.attachments!.download({
      identifier: GRANT,
      attachmentId: id,
      queryParams: { message_id: 'm2' },
    });
    expect(await new Response(stream).text()).toBe('note');
    const empty = filePart({ filename: 'e.bin', contentType: 'application/octet-stream', size: 0 });
    gmail.on('GET', /\/messages\/m3$/, () => ({
      json: { id: 'm3', threadId: 'm3', payload: multipart('multipart/mixed', [empty]) },
    }));
    const none = await googleMailAdapter.attachments!.download({
      identifier: GRANT,
      attachmentId: encodeAttachmentId({
        filename: 'e.bin',
        contentType: 'application/octet-stream',
        size: 0,
      }),
      queryParams: { messageId: 'm3' },
    });
    expect((await new Response(none).arrayBuffer()).byteLength).toBe(0);
  });

  test('a missing message id or part is an error', async () => {
    gmail.on('GET', /\/messages\/m1$/, () => ({ json: receiptMessage({ id: 'm1' }) }));
    await expect(
      googleMailAdapter.attachments!.download({ identifier: GRANT, attachmentId: STORED_ID }),
    ).rejects.toThrow('message id');
    const missing = (await googleMailAdapter
      .attachments!.download({
        identifier: GRANT,
        attachmentId: 'v0:bm9wZQ:eA:1',
        queryParams: { messageId: 'm1' },
      })
      .catch((e: unknown) => e)) as GoogleApiError;
    expect(missing.statusCode).toBe(404);
  });
});

describe('grants', () => {
  test('find reports the stored scopes, as a Nylas grant does', async () => {
    const grant = await googleMailAdapter.grants!.find({ grantId: GRANT });
    expect(grant.data).toEqual({
      id: GRANT,
      provider: 'google',
      grantStatus: 'valid',
      email: 'ann@example.com',
      scope: ['https://www.googleapis.com/auth/gmail.modify'],
    });
    __setGoogleMailAdapterDepsForTest({ loadCredentials: async () => null });
    await expect(googleMailAdapter.grants!.find({ grantId: GRANT })).rejects.toThrow('No grant found');
  });

  test('destroy revokes the token, removes the row, and destroys the old Nylas grant', async () => {
    await googleMailAdapter.grants!.destroy({ grantId: GRANT });
    expect(adapterCalls.revoke).toEqual(['refresh']);
    expect(adapterCalls.removeGrant).toEqual([{ grantId: GRANT }]);
    expect(adapterCalls.destroyNylas).toEqual(['nylas-grant-1']);
  });

  test('destroy goes on when the revoke or the Nylas destroy fails', async () => {
    __setGoogleMailAdapterDepsForTest({
      loadCredentials: async () => ({
        ...CREDENTIALS,
        refreshTokenEncrypted: undefined,
        accessTokenEncrypted: 'enc(access)',
      }),
      decryptSecret: (value: string) => value,
      revokeGoogleToken: async () => {
        throw new Error('network');
      },
      mutate: (async () => ({ removed: 1, previousNylasGrantIds: ['n1'] })) as any,
      destroyNylasGrant: async () => {
        throw new Error('nylas down');
      },
      sleep: async () => {},
    });
    expect(await googleMailAdapter.grants!.destroy({ grantId: GRANT })).toEqual({
      requestId: 'google-direct',
    });
  });

  test('a transient revoke failure is retried; a refusal is not', async () => {
    let attempts = 0;
    let failures = 2;
    const waits: number[] = [];
    __setGoogleMailAdapterDepsForTest({
      loadCredentials: async () => CREDENTIALS,
      decryptSecret: (value: string) => value,
      revokeGoogleToken: async () => {
        attempts += 1;
        if (failures-- > 0) throw new GoogleApiError(503, 'unavailable');
        return true;
      },
      mutate: (async () => ({ removed: 1, previousNylasGrantIds: [] })) as any,
      sleep: async (ms: number) => {
        waits.push(ms);
      },
    });
    await googleMailAdapter.grants!.destroy({ grantId: GRANT });
    expect(attempts).toBe(3);
    expect(waits).toEqual([250, 500]);
    attempts = 0;
    let removed = 0;
    __setGoogleMailAdapterDepsForTest({
      loadCredentials: async () => CREDENTIALS,
      decryptSecret: (value: string) => value,
      revokeGoogleToken: async () => {
        attempts += 1;
        throw new GoogleApiError(403, 'forbidden');
      },
      mutate: (async () => {
        removed += 1;
        return { removed: 1, previousNylasGrantIds: [] };
      }) as any,
      sleep: async () => {},
    });
    await googleMailAdapter.grants!.destroy({ grantId: GRANT });
    expect(attempts).toBe(1);
    expect(removed).toBe(1);
  });

  test('a token that cannot be read is not revoked, and the row still goes', async () => {
    let revoked = 0;
    let removed = 0;
    __setGoogleMailAdapterDepsForTest({
      loadCredentials: async () => CREDENTIALS,
      decryptSecret: () => {
        throw new Error('bad key');
      },
      revokeGoogleToken: async () => {
        revoked += 1;
        return true;
      },
      mutate: (async () => {
        removed += 1;
        return { removed: 1, previousNylasGrantIds: [] };
      }) as any,
    });
    await googleMailAdapter.grants!.destroy({ grantId: GRANT });
    expect(revoked).toBe(0);
    expect(removed).toBe(1);
  });
});

describe('router integration', () => {
  test('a routed client sends a google: grant to this adapter and a Nylas grant to Nylas', async () => {
    gmail.on('GET', /\/messages$/, () => ({ json: { messages: [] } }));
    const nylasCalls: string[] = [];
    const client = routeNylasClient({
      messages: {
        list: async (args: any) => {
          nylasCalls.push(args.identifier);
          return { data: [] };
        },
      },
    });
    await client.messages.list({ identifier: GRANT, queryParams: { limit: 5 } });
    await client.messages.list({ identifier: 'nylas-grant', queryParams: { limit: 5 } });
    expect(gmail.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      `GET ${new URL(API).pathname}/messages`,
    ]);
    expect(nylasCalls).toEqual(['nylas-grant']);
  });
});
