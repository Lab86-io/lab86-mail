import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { ConvexHttpClient } from 'convex/browser';
import { getFunctionName } from 'convex/server';
import { runWithAiRequestContext } from '../lib/ai/context';
import { api, convexMutation } from '../lib/hosted/convex';
import { upsertThreadInsight } from '../lib/store/thread-insights';
import { upsertThread } from '../lib/store/threads';

// The shared ConvexHttpClient runs its mutations one at a time for the whole
// server process. The thread cache writes of a brief skip that queue.
const saved = { url: process.env.NEXT_PUBLIC_CONVEX_URL, secret: process.env.LAB86_CONVEX_INTERNAL_SECRET };
const calls: Array<{ name: string; args: any; options: any }> = [];
const mutation = spyOn(ConvexHttpClient.prototype, 'mutation').mockImplementation((async (
  fn: any,
  args: any,
  options?: any,
) => {
  calls.push({ name: getFunctionName(fn), args, options });
  return { ok: true };
}) as any);
const query = spyOn(ConvexHttpClient.prototype, 'query').mockImplementation((async () => null) as any);
beforeAll(() => {
  process.env.NEXT_PUBLIC_CONVEX_URL = 'https://queue-test.convex.cloud';
  process.env.LAB86_CONVEX_INTERNAL_SECRET = 'queue-secret';
});
afterAll(() => {
  mutation.mockRestore();
  query.mockRestore();
  if (saved.url === undefined) delete process.env.NEXT_PUBLIC_CONVEX_URL;
  else process.env.NEXT_PUBLIC_CONVEX_URL = saved.url;
  if (saved.secret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
  else process.env.LAB86_CONVEX_INTERNAL_SECRET = saved.secret;
});

test('a mutation waits in the queue unless its caller asks to skip it', async () => {
  await convexMutation(api.userData.deleteDoc, { userId: 'u', kind: 'thread', key: 'k' });
  await convexMutation(
    api.userData.deleteDoc,
    { userId: 'u', kind: 'thread', key: 'k' },
    { skipQueue: true },
  );
  expect(calls.map((call) => call.options)).toEqual([undefined, { skipQueue: true }]);
  expect(calls[0].args.internalSecret).toBe('queue-secret');
});

test('the thread cache and insight writes skip the queue', async () => {
  calls.length = 0;
  await runWithAiRequestContext({ userId: 'owner', agent: 'ai' }, async () => {
    await upsertThread('acct', { _id: 't1', subject: 'Venue' });
    await upsertThreadInsight({ account: 'acct', threadId: 't1' } as any);
  });
  expect(calls.map((call) => [call.name, call.args.kind, call.options])).toEqual([
    ['userData:upsertDoc', 'thread', { skipQueue: true }],
    ['userData:upsertDoc', 'threadInsight', { skipQueue: true }],
  ]);
});
