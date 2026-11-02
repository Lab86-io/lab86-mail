import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as convexReact from 'convex/react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { InactiveBriefRefsLive } from '../components/report/brief-canvas/InactiveBriefRefsLive';

const KEY = ['brief-v2', 'inactive', 'test'];
const auth = (isAuthenticated: boolean) => ({ isLoading: false, isAuthenticated, isRefreshing: false });

function refs(count: number) {
  return Array.from({ length: count }, (_, index) => ({ kind: 'task', id: `card-${index}` }));
}

const restores: Array<() => void> = [];
afterEach(() => {
  for (const restore of restores.splice(0)) restore();
});

async function mount(input: { authed?: boolean; count?: number; answer?: (key: string) => unknown }) {
  const asked: Array<Record<string, { args: { refs: unknown[] } }>> = [];
  const authSpy = spyOn(convexReact, 'useConvexAuth').mockReturnValue(auth(input.authed ?? true));
  const queriesSpy = spyOn(convexReact, 'useQueries').mockImplementation(((queries: any) => {
    asked.push(queries);
    return Object.fromEntries(Object.keys(queries).map((key) => [key, input.answer?.(key)]));
  }) as any);
  restores.push(
    () => authSpy.mockRestore(),
    () => queriesSpy.mockRestore(),
  );
  const client = new QueryClient();
  const list = refs(input.count ?? 2);
  let view!: ReactTestRenderer;
  await act(async () => {
    view = create(
      <QueryClientProvider client={client}>
        <InactiveBriefRefsLive refs={list} queryKey={KEY} />
      </QueryClientProvider>,
    );
  });
  restores.push(() => view.unmount());
  return { client, asked, view };
}

describe('the live inactive subscription', () => {
  test('nothing subscribes before sign-in', async () => {
    const page = await mount({ authed: false });
    expect(page.asked.at(-1)).toEqual({});
    expect(page.client.getQueryData(KEY)).toBeUndefined();
  });

  test('the answer lands in the cache that the canvas reads, and it renders nothing', async () => {
    const page = await mount({ answer: () => ['card-1'] });
    expect(page.asked.at(-1)?.['0'].args.refs).toEqual([
      { kind: 'task', id: 'card-0' },
      { kind: 'task', id: 'card-1' },
    ]);
    expect(page.client.getQueryData<string[]>(KEY)).toEqual(['card-1']);
    expect(page.view.toJSON()).toBeNull();
  });

  test('a brief of many refs subscribes per batch and merges the answers', async () => {
    const page = await mount({ count: 250, answer: (key) => [`inactive-${key}`] });
    const queries = page.asked.at(-1) ?? {};
    expect(Object.keys(queries)).toEqual(['0', '100', '200']);
    expect(queries['200'].args.refs).toHaveLength(50);
    expect(page.client.getQueryData<string[]>(KEY)).toEqual(['inactive-0', 'inactive-100', 'inactive-200']);
  });

  test('a batch that has not answered yet writes nothing, and an error keeps the last answer', async () => {
    const waiting = await mount({ count: 150, answer: (key) => (key === '0' ? ['card-1'] : undefined) });
    expect(waiting.client.getQueryData(KEY)).toBeUndefined();
    const failed = await mount({ answer: () => new Error('Convex query failed') });
    expect(failed.client.getQueryData(KEY)).toBeUndefined();
  });
});
