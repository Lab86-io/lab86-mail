import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { getFunctionName } from 'convex/server';
import * as hosted from '../lib/hosted/convex';
import { cancelOutbox, claimOutbox, completeOutbox, enqueueOutbox, outboxStatus } from '../lib/send/outbox';

const spies: { mockRestore(): void }[] = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});
describe('held message storage transport', () => {
  test('binary attachments survive JSON storage as base64 and retain the caller identity', async () => {
    const calls: { name: string; args: any }[] = [];
    spies.push(
      spyOn(hosted, 'convexMutation').mockImplementation(async (fn, args): Promise<any> => {
        const name = getFunctionName(fn);
        calls.push({ name, args });
        return name.endsWith('uploadUrl')
          ? 'https://storage.example.test/upload'
          : { id: 'outbox:key', status: 'pending' };
      }),
    );
    let stored: any;
    spies.push(
      spyOn(globalThis, 'fetch').mockImplementation((async (url: any, init: any) => {
        expect(url).toBe('https://storage.example.test/upload');
        stored = JSON.parse(init.body);
        return Response.json({ storageId: 'blob-1' });
      }) as any),
    );
    const bytes = Buffer.from([0, 255, 128, 1, 42]);
    const result = await enqueueOutbox('owner', 'outbox:key', 10, {
      userId: 'owner',
      account: 'sender@example.test',
      to: 'recipient@example.test',
      subject: 'Files',
      body: 'Original body',
      html: '<p>Original body</p>',
      replyToMessageId: 'reply-anchor',
      attachments: [
        { filename: 'binary.dat', content: bytes, contentType: 'application/octet-stream' },
        { filename: 'encoded.txt', content: 'aGVsbG8=', contentType: 'text/plain' },
      ] as any,
    });
    expect(Buffer.from(stored.attachments[0].content, 'base64')).toEqual(bytes);
    expect(stored.attachments[1].content).toBe('aGVsbG8=');
    expect(stored).toMatchObject({
      userId: 'owner',
      body: 'Original body',
      replyToMessageId: 'reply-anchor',
    });
    expect(calls[1]).toEqual({
      name: 'mailOutbox:enqueue',
      args: { userId: 'owner', key: 'outbox:key', undoSeconds: 10, payloadId: 'blob-1' },
    });
    expect(result.status).toBe('pending');
  });
  test('upload rejection cannot enqueue a missing payload', async () => {
    const mutation = spyOn(hosted, 'convexMutation').mockResolvedValue('https://storage.example.test/upload');
    spies.push(mutation);
    spies.push(spyOn(globalThis, 'fetch').mockResolvedValue(new Response('Unavailable', { status: 503 })));
    await expect(
      enqueueOutbox('owner', 'outbox:key', 10, { account: 'a', to: 'b', subject: 'c', body: 'd' }),
    ).rejects.toThrow('Nothing was sent');
    expect(mutation).toHaveBeenCalledTimes(1);
  });
  test('cancel, status, claim and confirmation always carry the authenticated owner', async () => {
    const writes: any[] = [];
    spies.push(
      spyOn(hosted, 'convexMutation').mockImplementation(async (fn, args): Promise<any> => {
        writes.push({ name: getFunctionName(fn), args });
        return true;
      }),
    );
    const query = spyOn(hosted, 'convexQuery').mockResolvedValue({ status: 'pending' });
    spies.push(query);
    await cancelOutbox('owner', 'outbox:key');
    await claimOutbox('owner', 'outbox:key');
    await completeOutbox('owner', 'outbox:key', 'sent', 'message');
    expect(await outboxStatus('owner', 'outbox:key')).toMatchObject({ status: 'pending' });
    expect(writes.map((write) => write.name)).toEqual([
      'mailOutbox:cancel',
      'mailOutbox:claim',
      'mailOutbox:complete',
    ]);
    expect(writes.every((write) => write.args.userId === 'owner' && write.args.key === 'outbox:key')).toBe(
      true,
    );
    expect(writes[2].args).toMatchObject({ status: 'sent', messageId: 'message' });
    expect(query.mock.calls[0][1]).toEqual({ userId: 'owner', key: 'outbox:key' });
  });
});
