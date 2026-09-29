import { describe, expect, mock, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  AttachmentTooLargeError,
  drainMailAttachmentQueue,
  isPermanentAttachmentError,
  openMailAttachment,
  readBounded,
  readMailAttachmentBytes,
  storeMailAttachmentBytes,
} from '../lib/attachments/mail-files';
import { ATTACHMENT_STORE_MAX_BYTES } from '../lib/attachments/store-policy';

const NOW = Date.now();
const ref = { userId: 'u1', account: 'me@example.com', messageId: 'm1', attachmentId: 'a1' };
const encoder = new TextEncoder();
const text = (stream: ReadableStream<Uint8Array>) => new Response(stream).text();
const streamOf = (value: string) => new Response(value).body as ReadableStream<Uint8Array>;

type Lookup = Record<string, unknown> | null | undefined;
function harness(lookup: Lookup, options: { provider?: unknown; storeStatus?: string[] } = {}) {
  const mutations: Array<{ args: any }> = [];
  const statuses = [...(options.storeStatus ?? ['upload', 'stored'])];
  const tasks: Array<() => Promise<unknown>> = [];
  const deps = {
    convexQuery: mock(async (): Promise<any> => {
      if (lookup === undefined) throw new Error('convex down');
      return lookup;
    }),
    convexMutation: mock(async (_fn: any, args: any): Promise<any> => {
      mutations.push({ args });
      if ('sha256' in args) return { status: statuses.shift() ?? 'stored' };
      if ('queueId' in args) return { ok: true };
      if (Object.keys(args).length === 0) return 'https://storage.example/upload';
      return [];
    }),
    downloadNylasAttachment: mock(
      async (_args: any): Promise<any> =>
        'provider' in options ? options.provider : streamOf('provider bytes'),
    ),
    fetch: mock(async (url: string, init?: RequestInit): Promise<Response> => {
      if (init?.method === 'POST') return Response.json({ storageId: 'storage_1' });
      if (url.includes('broken')) return new Response('no', { status: 500 });
      if (url.includes('throws')) throw new Error('network');
      return new Response('stored bytes');
    }),
  };
  const defer = mock((task: () => Promise<unknown>) => {
    tasks.push(task);
  });
  const runTasks = async () => {
    for (const task of tasks.splice(0)) await task();
  };
  return { deps, mutations, defer, runTasks };
}

const connected = (extra: Record<string, unknown> = {}) => ({
  accountId: 'acct',
  connected: true,
  file: null,
  corpus: {
    filename: 'Invoice.pdf',
    mimeType: 'application/pdf',
    size: 14,
    receivedAt: NOW - 86_400_000,
    labels: ['INBOX'],
  },
  ...extra,
});

describe('openMailAttachment', () => {
  test('serves a stored file from storage and never calls the provider', async () => {
    const h = harness(
      connected({
        file: { url: 'https://storage.example/f', filename: 'f.pdf', mimeType: 'application/pdf', size: 12 },
      }),
    );
    const opened = await openMailAttachment(ref, { fill: 'always', defer: h.defer }, h.deps);
    expect(opened).toMatchObject({
      source: 'store',
      filename: 'f.pdf',
      mimeType: 'application/pdf',
      size: 12,
    });
    expect(await text(opened!.stream)).toBe('stored bytes');
    expect(h.deps.downloadNylasAttachment).not.toHaveBeenCalled();
    expect(h.defer).not.toHaveBeenCalled();
    expect((h.deps.convexQuery.mock.calls[0] as any[])[1]).toEqual({
      userId: 'u1',
      account: 'me@example.com',
      providerMessageId: 'm1',
      attachmentId: 'a1',
    });
  });

  test('falls back to the provider when the stored read fails, and stores a copy', async () => {
    for (const url of ['https://storage.example/broken', 'https://storage.example/throws']) {
      const h = harness(connected({ file: { url, filename: 'f', mimeType: 'x', size: 1 } }));
      const opened = await openMailAttachment(ref, { fill: 'always', defer: h.defer }, h.deps);
      expect(opened?.source).toBe('provider');
      expect(await text(opened!.stream)).toBe('provider bytes');
      expect((h.deps.downloadNylasAttachment.mock.calls[0] as any[])[0]).toEqual({
        userId: 'u1',
        account: 'acct',
        messageId: 'm1',
        attachmentId: 'a1',
      });
      await h.runTasks();
      const records = h.mutations.filter((entry) => 'sha256' in entry.args);
      expect(records).toHaveLength(2);
      expect(records[0].args).toEqual({
        userId: 'u1',
        accountId: 'acct',
        providerMessageId: 'm1',
        attachmentId: 'a1',
        filename: 'Invoice.pdf',
        mimeType: 'application/pdf',
        size: 14,
        sha256: createHash('sha256').update('provider bytes').digest('hex'),
      });
      expect(records[1].args.storageId).toBe('storage_1');
      const upload = h.deps.fetch.mock.calls.find((call: any[]) => call[1]?.method === 'POST') as any[];
      expect(upload[0]).toBe('https://storage.example/upload');
      expect(upload[1].headers).toEqual({ 'content-type': 'application/octet-stream' });
    }
  });

  test('no match, no live mailbox, or no provider file gives null', async () => {
    expect(await openMailAttachment(ref, {}, harness(null).deps)).toBeNull();
    const dead = harness(connected({ connected: false }));
    expect(await openMailAttachment(ref, { fill: 'always' }, dead.deps)).toBeNull();
    expect(dead.deps.downloadNylasAttachment).not.toHaveBeenCalled();
    expect(await openMailAttachment(ref, {}, harness(connected(), { provider: null }).deps)).toBeNull();
  });

  test('a failed lookup still serves from the provider, without a stored copy', async () => {
    const h = harness(undefined);
    const opened = await openMailAttachment(
      ref,
      { fill: 'always', hint: { filename: 'h.txt' }, defer: h.defer },
      h.deps,
    );
    expect(opened).toMatchObject({ source: 'provider', filename: 'h.txt' });
    expect((h.deps.downloadNylasAttachment.mock.calls[0] as any[])[0].account).toBe('me@example.com');
    expect(h.defer).not.toHaveBeenCalled();
  });

  test('fill rules: never, the size cap, and the queue policy', async () => {
    const never = harness(connected());
    await openMailAttachment(ref, { defer: never.defer }, never.deps);
    expect(never.defer).not.toHaveBeenCalled();

    const big = harness(
      connected({ corpus: { ...connected().corpus, size: ATTACHMENT_STORE_MAX_BYTES + 1 } }),
    );
    await openMailAttachment(ref, { fill: 'always', defer: big.defer }, big.deps);
    expect(big.defer).not.toHaveBeenCalled();

    const policy = harness(connected());
    await openMailAttachment(ref, { fill: 'policy', defer: policy.defer }, policy.deps);
    expect(policy.defer).toHaveBeenCalledTimes(1);

    const spam = harness(connected({ corpus: { ...connected().corpus, labels: ['SPAM'] } }));
    await openMailAttachment(ref, { fill: 'policy', defer: spam.defer }, spam.deps);
    expect(spam.defer).not.toHaveBeenCalled();

    const unknownAge = harness(connected({ corpus: null }));
    await openMailAttachment(ref, { fill: 'policy', defer: unknownAge.defer }, unknownAge.deps);
    expect(unknownAge.defer).not.toHaveBeenCalled();

    const hinted = harness(connected({ corpus: null }));
    const opened = await openMailAttachment(
      ref,
      {
        fill: 'policy',
        hint: { receivedAt: NOW, size: 20_000, mimeType: 'image/png', filename: 'p.png' },
        defer: hinted.defer,
      },
      hinted.deps,
    );
    expect(opened).toMatchObject({ filename: 'p.png', mimeType: 'image/png', size: 20_000 });
    expect(hinted.defer).toHaveBeenCalledTimes(1);
  });

  test('a provider file over the cap is served but not stored', async () => {
    const huge = new Uint8Array(ATTACHMENT_STORE_MAX_BYTES + 1);
    const h = harness(connected({ corpus: null }), { provider: new Response(huge).body });
    const opened = await openMailAttachment(ref, { fill: 'always', defer: h.defer }, h.deps);
    const served = await new Response(opened!.stream).arrayBuffer();
    await h.runTasks();
    expect(served.byteLength).toBe(huge.byteLength);
    expect(h.mutations).toEqual([]);
  });

  test('the stored copy is read at once and stops at the cap, while the reader waits', async () => {
    // A provider file larger than the cap, in 1 MiB chunks, with no size in the corpus.
    const chunk = new Uint8Array(1024 * 1024);
    const total = ATTACHMENT_STORE_MAX_BYTES + 8 * chunk.byteLength;
    let pulled = 0;
    const provider = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (pulled >= total) return controller.close();
          pulled += chunk.byteLength;
          controller.enqueue(chunk);
        },
      },
      { highWaterMark: 0 },
    );
    const h = harness(connected({ corpus: null }), { provider });
    const opened = await openMailAttachment(ref, { fill: 'always', defer: h.defer }, h.deps);
    // The reader reads nothing yet, and the store task has not run.
    let last = -1;
    for (let i = 0; i < 500 && pulled !== last; i++) {
      last = pulled;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(h.defer).toHaveBeenCalledTimes(1);
    // The copy read the file up to the cap, then stopped: the rest waits for the reader.
    expect(pulled).toBeGreaterThan(ATTACHMENT_STORE_MAX_BYTES);
    expect(pulled).toBeLessThan(total);
    const served = await new Response(opened!.stream).arrayBuffer();
    expect(served.byteLength).toBe(total);
    await h.runTasks();
    expect(h.mutations).toEqual([]);
  });

  test('a provider error reaches the store task as a logged failure, not an unhandled rejection', async () => {
    const provider = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error('provider reset'));
      },
    });
    const h = harness(connected({ corpus: null }), { provider });
    const errors = mock(() => undefined);
    const original = console.error;
    console.error = errors;
    try {
      const opened = await openMailAttachment(ref, { fill: 'always', defer: h.defer }, h.deps);
      // The reader gets the provider error.
      await expect(opened!.stream.getReader().read()).rejects.toThrow('provider reset');
      await new Promise((resolve) => setTimeout(resolve, 0));
      await h.runTasks();
    } finally {
      console.error = original;
    }
    expect(errors).toHaveBeenCalledTimes(1);
    expect(String((errors.mock.calls[0] as unknown[])[1])).toContain('provider reset');
    expect(h.mutations).toEqual([]);
  });

  test('the default defer runs the store and logs a failure', async () => {
    const h = harness(connected());
    h.deps.convexMutation.mockImplementation(async () => {
      throw new Error('convex down');
    });
    const errors = mock(() => undefined);
    const original = console.error;
    console.error = errors;
    try {
      const opened = await openMailAttachment(ref, { fill: 'always' }, h.deps);
      expect(await text(opened!.stream)).toBe('provider bytes');
      for (let i = 0; i < 5 && !errors.mock.calls.length; i++) await new Promise((r) => setTimeout(r, 5));
    } finally {
      console.error = original;
    }
    expect(errors).toHaveBeenCalled();
  });
});

test('a failed store through a custom defer resolves, and goes to the log', async () => {
  const h = harness(connected());
  h.deps.convexMutation.mockImplementation(async () => {
    throw new Error('convex down');
  });
  const errors = mock(() => undefined);
  const original = console.error;
  console.error = errors;
  try {
    const read = await readMailAttachmentBytes(ref, { fill: 'always', defer: h.defer }, h.deps);
    expect(read?.source).toBe('provider');
    await h.runTasks();
  } finally {
    console.error = original;
  }
  expect(errors).toHaveBeenCalledTimes(1);
});

describe('readMailAttachmentBytes', () => {
  test('reads stored bytes, and provider bytes that are then stored', async () => {
    const stored = harness(
      connected({
        file: { url: 'https://storage.example/f', filename: 'f', mimeType: 'text/plain', size: 12 },
      }),
    );
    const fromStore = await readMailAttachmentBytes(
      ref,
      { fill: 'always', defer: stored.defer },
      stored.deps,
    );
    expect(new TextDecoder().decode(fromStore!.bytes)).toBe('stored bytes');
    expect(fromStore).toMatchObject({ source: 'store', filename: 'f', mimeType: 'text/plain' });
    expect(stored.defer).not.toHaveBeenCalled();

    const provider = harness(connected());
    const fromProvider = await readMailAttachmentBytes(
      ref,
      { fill: 'always', defer: provider.defer },
      provider.deps,
    );
    expect(fromProvider?.source).toBe('provider');
    await provider.runTasks();
    expect(provider.mutations.filter((entry) => 'sha256' in entry.args)).toHaveLength(2);

    const never = harness(connected());
    await readMailAttachmentBytes(ref, { defer: never.defer }, never.deps);
    expect(never.defer).not.toHaveBeenCalled();
    expect(await readMailAttachmentBytes(ref, {}, harness(null).deps)).toBeNull();
  });

  test('a provider body that is not a web stream is read too', async () => {
    const h = harness(connected(), { provider: 'plain body' });
    const read = await readMailAttachmentBytes(ref, {}, h.deps);
    expect(new TextDecoder().decode(read!.bytes)).toBe('plain body');
  });

  test('throws AttachmentTooLargeError above maxBytes', async () => {
    const h = harness(connected());
    const error = await readMailAttachmentBytes(ref, { maxBytes: 4 }, h.deps).catch((e) => e);
    expect(error).toBeInstanceOf(AttachmentTooLargeError);
    expect(error.message).toContain('size limit');
    expect(isPermanentAttachmentError(error)).toBe(true);
  });
});

describe('storeMailAttachmentBytes', () => {
  const input = {
    userId: 'u1',
    accountId: 'acct',
    providerMessageId: 'm1',
    attachmentId: 'a1',
    filename: 'f.pdf',
    mimeType: 'Application/PDF; name=f.pdf',
    bytes: encoder.encode('bytes'),
  };

  test('a known hash needs no upload', async () => {
    const h = harness(null, { storeStatus: ['stored'] });
    expect(await storeMailAttachmentBytes(input, h.deps)).toBe('stored');
    expect(h.mutations).toHaveLength(1);
    expect(h.mutations[0].args.mimeType).toBe('application/pdf');
    expect(h.deps.fetch).not.toHaveBeenCalled();
  });

  test('too large, a failed upload, and a record that still asks for an upload', async () => {
    const h = harness(null);
    expect(
      await storeMailAttachmentBytes(
        { ...input, bytes: new Uint8Array(ATTACHMENT_STORE_MAX_BYTES + 1) },
        h.deps,
      ),
    ).toBe('too_large');
    expect(h.mutations).toEqual([]);
    h.deps.fetch.mockImplementation(async () => new Response('no', { status: 503 }));
    await expect(storeMailAttachmentBytes({ ...input, mimeType: '' }, h.deps)).rejects.toThrow(
      'upload failed (503)',
    );
    expect(h.mutations[0].args.mimeType).toBe('application/octet-stream');
    const again = harness(null, { storeStatus: ['upload', 'upload'] });
    expect(await storeMailAttachmentBytes(input, again.deps)).toBe('skipped');
  });
});

describe('drainMailAttachmentQueue', () => {
  const item = (attachmentId: string, extra: Record<string, unknown> = {}) => ({
    queueId: `q_${attachmentId}`,
    accountId: 'acct',
    providerMessageId: 'm1',
    attachmentId,
    filename: `${attachmentId}.bin`,
    mimeType: 'application/octet-stream',
    size: 10,
    attempts: 1,
    ...extra,
  });

  test('stores each claimed file and records each failure by kind', async () => {
    const h = harness(null, { storeStatus: ['upload', 'stored', 'skipped'] });
    const items = [
      item('ok'),
      item('skipped'),
      item('missing'),
      item('gone'),
      item('pixel', { mimeType: 'image/gif' }),
      item('huge'),
      item('flaky'),
    ];
    h.deps.convexMutation.mockImplementationOnce(async () => items);
    h.deps.downloadNylasAttachment.mockImplementation(async (args: any) => {
      const id = args.attachmentId;
      if (id === 'missing') return null;
      if (id === 'gone') throw Object.assign(new Error('Not found'), { statusCode: 404 });
      if (id === 'pixel') return streamOf('tiny');
      if (id === 'huge') return new Response(new Uint8Array(ATTACHMENT_STORE_MAX_BYTES + 1)).body;
      if (id === 'flaky') throw Object.assign(new Error('Busy'), { statusCode: 503 });
      return streamOf(`${id} bytes`);
    });
    const counts = await drainMailAttachmentQueue('u1', h.deps);
    expect(counts).toEqual({ claimed: 7, stored: 1, skipped: 2, failed: 4 });
    const failures = h.mutations
      .filter((entry) => 'queueId' in entry.args)
      .map((entry) => [entry.args.queueId, entry.args.permanent, entry.args.error]);
    expect(failures).toEqual([
      ['q_missing', false, 'The mailbox is not connected.'],
      ['q_gone', true, '404 Not found'],
      ['q_pixel', true, 'Inline part below the size floor.'],
      ['q_huge', true, 'File exceeds the size limit (26 MB).'],
      ['q_flaky', false, '503 Busy'],
    ]);
    // Each download goes through the provider path in the owner's mailbox.
    expect((h.deps.downloadNylasAttachment.mock.calls[0] as any[])[0]).toEqual({
      userId: 'u1',
      account: 'acct',
      messageId: 'm1',
      attachmentId: 'ok',
    });
  });

  test('a failure record that fails goes to the log', async () => {
    const h = harness(null);
    h.deps.convexMutation.mockImplementation(async (_fn: any, args: any) => {
      if ('queueId' in args) throw new Error('convex down');
      return [item('flaky')];
    });
    h.deps.downloadNylasAttachment.mockImplementation(async () => {
      throw new Error('network');
    });
    const errors = mock(() => undefined);
    const original = console.error;
    console.error = errors;
    try {
      expect(await drainMailAttachmentQueue('u1', h.deps)).toEqual({
        claimed: 1,
        stored: 0,
        skipped: 0,
        failed: 1,
      });
    } finally {
      console.error = original;
    }
    expect(errors).toHaveBeenCalledTimes(1);
  });

  test('at most two files download at the same time, over all users', async () => {
    const h = harness(null, { storeStatus: Array(12).fill('stored') });
    h.deps.convexMutation.mockImplementation(async (_fn: any, args: any) =>
      'sha256' in args ? { status: 'stored' } : [item(`${args.userId}-1`), item(`${args.userId}-2`)],
    );
    let active = 0;
    let peak = 0;
    h.deps.downloadNylasAttachment.mockImplementation(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return streamOf('bytes');
    });
    const runs = await Promise.all(
      ['u1', 'u2', 'u3'].map((userId) => drainMailAttachmentQueue(userId, h.deps)),
    );
    expect(runs.map((run) => run.stored)).toEqual([2, 2, 2]);
    expect(peak).toBe(2);
  });
});

describe('helpers', () => {
  test('permanent errors are 403, 404, 410, and a file over the limit', () => {
    for (const status of [403, 404, 410])
      expect(isPermanentAttachmentError(Object.assign(new Error('x'), { statusCode: status }))).toBe(true);
    expect(isPermanentAttachmentError({ response: { status: 410 } })).toBe(true);
    expect(isPermanentAttachmentError(Object.assign(new Error('x'), { status: 500 }))).toBe(false);
    expect(isPermanentAttachmentError('x')).toBe(false);
  });

  test('readBounded reads to the limit and stops above it', async () => {
    expect(new TextDecoder().decode((await readBounded(streamOf('abcd'), 4)) as Uint8Array)).toBe('abcd');
    expect(await readBounded(streamOf('abcde'), 4)).toBeNull();
    expect((await readBounded(streamOf(''), 4))?.byteLength).toBe(0);
  });
});
