import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { convexTest } from 'convex-test';
import { api, internal } from '../convex/_generated/api';
import schema from '../convex/schema';

const modules = {
  '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
  '../convex/mailOutbox.ts': () => import('../convex/mailOutbox'),
};
const secret = 'outbox-tests';
const previous = process.env.LAB86_CONVEX_INTERNAL_SECRET;
beforeAll(() => {
  process.env.LAB86_CONVEX_INTERNAL_SECRET = secret;
});
afterAll(() => {
  if (previous === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
  else process.env.LAB86_CONVEX_INTERNAL_SECRET = previous;
});
const outbox = (api as any).mailOutbox;
const identity = () => ({ internalSecret: secret, userId: 'owner', key: `outbox:${crypto.randomUUID()}` });
async function setup() {
  const t = convexTest(schema, modules);
  const args = identity();
  const payloadId = await t.run((ctx) => ctx.storage.store(new Blob(['{"body":"hello"}'])));
  const receipt = await t.mutation(outbox.enqueue, { ...args, payloadId, undoSeconds: 10 });
  const due = () =>
    t.run(async (ctx) => {
      const row = await ctx.db.query('mailOutbox').first();
      await ctx.db.patch(row!._id, { fireAt: Date.now() - 1 });
    });
  return { t, args, payloadId, receipt, due };
}
describe('durable undo outbox', () => {
  test('nothing can claim the send before its full undo window; only one worker can send after', async () => {
    const { t, args, receipt, due } = await setup();
    expect(receipt.fireAt).toBeGreaterThan(Date.now() + 9000);
    expect(await t.mutation(outbox.claim, args)).toBeNull();
    await due();
    const claims = await Promise.all([t.mutation(outbox.claim, args), t.mutation(outbox.claim, args)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await t.mutation(outbox.cancel, args)).toBe(false);
    await t.mutation(outbox.complete, { ...args, status: 'sent', messageId: 'sent-1' });
    expect(await t.query(outbox.status, args)).toMatchObject({ status: 'sent' });
  });
  test('cancellation removes held content and prevents dispatch, including duplicate requests', async () => {
    const { t, args, payloadId, due } = await setup();
    expect(await t.mutation(outbox.cancel, args)).toBe(true);
    expect(await t.mutation(outbox.cancel, args)).toBe(true);
    await due();
    expect(await t.mutation(outbox.claim, args)).toBeNull();
    expect(await t.run((ctx) => ctx.storage.get(payloadId))).toBeNull();
  });
  test('Undo arriving before preparation wins against the later enqueue', async () => {
    const t = convexTest(schema, modules);
    const args = identity();
    await t.mutation(outbox.cancel, args);
    const payloadId = await t.run((ctx) => ctx.storage.store(new Blob(['late draft'])));
    expect(await t.mutation(outbox.enqueue, { ...args, payloadId, undoSeconds: 5 })).toMatchObject({
      status: 'cancelled',
    });
    expect(await t.run((ctx) => ctx.storage.get(payloadId))).toBeNull();
    expect(await t.mutation(outbox.claim, args)).toBeNull();
  });
  test('lost enqueue acknowledgments cannot duplicate or extend a send', async () => {
    const { t, args, receipt } = await setup();
    const payloadId = await t.run((ctx) => ctx.storage.store(new Blob(['duplicate'])));
    expect(await t.mutation(outbox.enqueue, { ...args, payloadId, undoSeconds: 300 })).toEqual(receipt);
    expect(await t.run((ctx) => ctx.storage.get(payloadId))).toBeNull();
  });
  test('another user cannot observe or cancel the owner’s held send', async () => {
    const { t, args } = await setup();
    expect(await t.query(outbox.status, { ...args, userId: 'other' })).toEqual({ status: 'unknown' });
    await t.mutation(outbox.cancel, { ...args, userId: 'other' });
    expect(await t.query(outbox.status, args)).toMatchObject({ status: 'pending' });
    await expect(t.query(outbox.status, { ...args, internalSecret: 'wrong' })).rejects.toThrow();
  });
  test('a crashed handoff becomes uncertain without ever resending; late confirmation resolves it', async () => {
    const { t, args, due } = await setup();
    await due();
    await t.mutation(outbox.claim, args);
    await t.mutation((internal as any).mailOutbox.handoffExpired, { userId: args.userId, key: args.key });
    expect(await t.query(outbox.status, args)).toMatchObject({ status: 'unknown' });
    expect(await t.mutation(outbox.claim, args)).toBeNull();
    await t.mutation(outbox.complete, { ...args, status: 'sent' });
    expect(await t.query(outbox.status, args)).toMatchObject({ status: 'sent' });
  });
});
