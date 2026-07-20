import { describe, expect, test } from 'bun:test';
import { drainPendingSweepPages } from '../lib/mail/llm-classify';

describe('LLM pending sweep continuation', () => {
  test('continues after an empty repair page when source work remains', async () => {
    const pages = [
      { items: [] as string[], moreRemaining: true },
      { items: ['grounded'], moreRemaining: false },
    ];
    const handled: string[][] = [];
    const result = await drainPendingSweepPages({
      loadPage: async () => pages.shift() ?? { items: [], moreRemaining: false },
      handleItems: async (items) => {
        handled.push(items);
        return items.length;
      },
      batchSize: 2,
      maxBatches: 3,
    });

    expect(result).toEqual({ classified: 1, moreRemaining: false });
    expect(handled).toEqual([['grounded']]);
    expect(pages).toHaveLength(0);
  });

  test('continues after a short grounded page when source work remains', async () => {
    const pages = [
      { items: ['first'], moreRemaining: true },
      { items: ['second'], moreRemaining: false },
    ];
    const handled: string[] = [];
    const result = await drainPendingSweepPages({
      loadPage: async () => pages.shift() ?? { items: [], moreRemaining: false },
      handleItems: async (items) => {
        handled.push(...items);
        return items.length;
      },
      batchSize: 2,
      maxBatches: 3,
    });

    expect(result).toEqual({ classified: 2, moreRemaining: false });
    expect(handled).toEqual(['first', 'second']);
  });

  test('reports remaining work when the bounded sweep budget is exhausted', async () => {
    const result = await drainPendingSweepPages({
      loadPage: async () => ({ items: [] as string[], moreRemaining: true }),
      handleItems: async () => 0,
      batchSize: 2,
      maxBatches: 2,
    });
    expect(result).toEqual({ classified: 0, moreRemaining: true });
  });
});
