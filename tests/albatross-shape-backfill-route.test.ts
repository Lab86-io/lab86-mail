import { describe, expect, test } from 'bun:test';
import { createShapeBackfillPost } from '../app/api/cron/shape-backfill/route';

const request = (body: unknown) => ({ json: async () => body }) as any;

function deps(overrides: Record<string, any> = {}) {
  const writes: any[] = [];
  const base = {
    isInternalCronRequest: () => true,
    listUnshaped: async () => [{ workId: 'w1', title: null, rawText: 'Book the dentist' }],
    applyWrite: async (input: any) => {
      writes.push(input);
      return { skipped: false };
    },
    plan: async (rows: any[]) => rows.map((row) => ({ workId: row.workId, shape: 'quick' })),
    ...overrides,
  };
  return { deps: base as any, writes };
}

describe('shape backfill route', () => {
  test('refuses a request without the internal secret', async () => {
    const { deps: d } = deps({ isInternalCronRequest: () => false });
    const response = await createShapeBackfillPost(d)(request({ userId: 'u1' }));
    expect(response.status).toBe(401);
  });

  test('needs a user', async () => {
    const { deps: d } = deps();
    const response = await createShapeBackfillPost(d)(request({}));
    expect(response.status).toBe(400);
  });

  test('writes one shape for each row it read', async () => {
    const { deps: d, writes } = deps();
    const response = await createShapeBackfillPost(d)(request({ userId: 'u1' }));
    const body = await response.json();
    expect(body).toMatchObject({ ok: true, read: 1, written: 1, byShape: { quick: 1 } });
    expect(writes[0]).toMatchObject({ userId: 'u1', workId: 'w1', shape: 'quick' });
  });

  test('answers plainly when there is nothing left to shape', async () => {
    const { deps: d } = deps({ listUnshaped: async () => [] });
    const response = await createShapeBackfillPost(d)(request({ userId: 'u1' }));
    const body = await response.json();
    expect(body).toMatchObject({ ok: true, read: 0, written: 0, remaining: 0 });
  });

  test('a failed write does not stop the batch', async () => {
    const { deps: d } = deps({
      listUnshaped: async () => [
        { workId: 'w1', title: null, rawText: 'One' },
        { workId: 'w2', title: null, rawText: 'Two' },
      ],
      applyWrite: async (input: any) => {
        if (input.workId === 'w1') throw new Error('write failed');
        return { skipped: false };
      },
    });
    const response = await createShapeBackfillPost(d)(request({ userId: 'u1' }));
    const body = await response.json();
    expect(body).toMatchObject({ ok: true, read: 2, written: 1 });
  });

  test('reports a full batch as more work', async () => {
    const { deps: d } = deps({
      listUnshaped: async () => [{ workId: 'w1', title: null, rawText: 'One' }],
    });
    const response = await createShapeBackfillPost(d)(request({ userId: 'u1', limit: 1 }));
    const body = await response.json();
    expect(body.remaining).toBe('more');
  });

  test('reports a failure', async () => {
    const { deps: d } = deps({
      listUnshaped: async () => {
        throw new Error('convex down');
      },
    });
    const response = await createShapeBackfillPost(d)(request({ userId: 'u1' }));
    expect(response.status).toBe(500);
  });
});
