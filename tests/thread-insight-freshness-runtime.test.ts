import { afterAll, beforeAll, expect, test } from 'bun:test';
import { convexTest } from 'convex-test';
import { api } from '../convex/_generated/api';
import schema from '../convex/schema';

// The thread insight writes of a brief skip the shared mutation queue, so two
// brief runs can write one thread at the same time. The stored insight keeps
// the newest generatedAt.

const modules = {
  '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
  '../convex/userData.ts': () => import('../convex/userData'),
};
const SECRET = 'thread-insight-secret';
const USER = 'insight_user';
let previousSecret: string | undefined;
beforeAll(() => {
  previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
  process.env.LAB86_CONVEX_INTERNAL_SECRET = SECRET;
});
afterAll(() => {
  if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
  else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
});

const harness = () => convexTest(schema, modules);
type Harness = ReturnType<typeof harness>;

function write(t: Harness, kind: string, doc: Record<string, unknown>) {
  return t.mutation(api.userData.upsertDoc, {
    internalSecret: SECRET,
    userId: USER,
    kind,
    key: 'acct:t1',
    doc,
  });
}

async function stored(t: Harness, kind: string) {
  const row = await t.run((ctx) =>
    ctx.db
      .query('userDocs')
      .withIndex('by_user_kind_key', (q) => q.eq('userId', USER).eq('kind', kind).eq('key', 'acct:t1'))
      .unique(),
  );
  return row?.doc;
}

test('an older thread insight does not replace a newer one', async () => {
  const t = harness();
  expect(await write(t, 'threadInsight', { reason: 'first', generatedAt: 200 })).toEqual({
    ok: true,
    created: true,
  });
  // The slower run finishes last with an older insight: the newer one stays.
  expect(await write(t, 'threadInsight', { reason: 'older', generatedAt: 100 })).toEqual({
    ok: true,
    created: false,
    stale: true,
  });
  expect(await stored(t, 'threadInsight')).toEqual({ reason: 'first', generatedAt: 200 });
  // A newer or equal insight replaces it.
  await write(t, 'threadInsight', { reason: 'newer', generatedAt: 300 });
  expect(await stored(t, 'threadInsight')).toEqual({ reason: 'newer', generatedAt: 300 });
  await write(t, 'threadInsight', { reason: 'same time', generatedAt: 300 });
  expect(await stored(t, 'threadInsight')).toEqual({ reason: 'same time', generatedAt: 300 });
  // A row with no time is replaced as before.
  await write(t, 'threadInsight', { reason: 'no time' });
  await write(t, 'threadInsight', { reason: 'timed', generatedAt: 1 });
  expect(await stored(t, 'threadInsight')).toEqual({ reason: 'timed', generatedAt: 1 });
});

test('other kinds keep the last write', async () => {
  const t = harness();
  await write(t, 'thread', { subject: 'new', generatedAt: 200 });
  await write(t, 'thread', { subject: 'old', generatedAt: 100 });
  expect(await stored(t, 'thread')).toEqual({ subject: 'old', generatedAt: 100 });
});
