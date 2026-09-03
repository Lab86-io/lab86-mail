import { describe, expect, test } from 'bun:test';
import { postSplit } from '../components/albatross/SplitSheet';

describe('split sheet requests', () => {
  test('propose posts to the split route and returns the proposal', async () => {
    let request: { url: string; body: Record<string, unknown> } | undefined;
    const result = await postSplit('work/1', { mode: 'propose' }, async (url, init) => {
      request = { url, body: JSON.parse(String(init.body)) };
      return Response.json({ ok: true, items: [{ title: 'A', rawText: 'A.' }] });
    });
    expect(request?.url).toBe('/api/albatross/work/work%2F1/split');
    expect(request?.body).toEqual({ mode: 'propose' });
    expect(result.items).toHaveLength(1);
  });

  test('a server error surfaces its message', async () => {
    await expect(
      postSplit('work-1', { mode: 'commit', items: [] }, async () =>
        Response.json({ ok: false, error: 'A split needs at least 2 Works.' }, { status: 400 }),
      ),
    ).rejects.toThrow('A split needs at least 2 Works.');
  });

  test('a non-json failure falls back to the generic message', async () => {
    await expect(
      postSplit(
        'work-1',
        { mode: 'propose' },
        async () => new Response('<html>bad gateway</html>', { status: 502 }),
      ),
    ).rejects.toThrow('The split failed.');
  });
});
