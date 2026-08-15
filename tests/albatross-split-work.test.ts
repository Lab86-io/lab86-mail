import { describe, expect, mock, test } from 'bun:test';
import {
  commitWorkSplit,
  parseWorkSplitProposal,
  proposeWorkSplit,
} from '../lib/albatross/split-work';

const detail = {
  work: {
    _id: 'work-blob',
    title: 'Massage, sheets, and dinner for Tree',
    rawText: 'Book a massage for Tree, get her new sheets, and reserve her something for dinner.',
    workState: 'active',
    primaryAreaId: 'area-personal',
  },
  plan: {
    outcome: 'Tree has a massage, new sheets, and a dinner reservation',
    digitalActions: [{ title: 'Find a massage studio' }],
    physicalActions: [{ title: 'Pick a restaurant' }],
  },
};

describe('parseWorkSplitProposal', () => {
  test('parses a fenced proposal', () => {
    const items = parseWorkSplitProposal(
      '```json\n{"work":[{"title":"Book a massage","rawText":"Book it."},{"title":"Order sheets","rawText":"Order them."}]}\n```',
    );
    expect(items.map((item) => item.title)).toEqual(['Book a massage', 'Order sheets']);
  });

  test('refuses a proposal with one child', () => {
    expect(() =>
      parseWorkSplitProposal('{"work":[{"title":"Only one","rawText":"One."}]}'),
    ).toThrow('A split could not be proposed.');
  });

  test('refuses garbage', () => {
    expect(() => parseWorkSplitProposal('no json here')).toThrow('A split could not be proposed.');
  });
});

describe('proposeWorkSplit', () => {
  test('grounds the proposal in the work, the plan steps, and the focus', async () => {
    const generate = mock(async (options: any) => {
      const prompt = JSON.parse(options.prompt);
      expect(prompt.planSteps).toEqual(['Find a massage studio', 'Pick a restaurant']);
      expect(prompt.focus).toBe('the sheets');
      return {
        text: '{"work":[{"title":"Order sheets","rawText":"Order them."},{"title":"The rest","rawText":"Massage and dinner."}]}',
      };
    });
    const proposal = await proposeWorkSplit(
      { userId: 'user-1', workId: 'work-blob', focus: 'the sheets' },
      { generate: generate as any, query: mock(async () => detail) as any },
    );
    expect(proposal.items).toHaveLength(2);
    expect(proposal.workTitle).toBe('Tree has a massage, new sheets, and a dinner reservation');
  });

  test('throws when the work is missing', async () => {
    await expect(
      proposeWorkSplit(
        { userId: 'user-1', workId: 'work-x' },
        { generate: mock(async () => ({ text: '' })) as any, query: mock(async () => null) as any },
      ),
    ).rejects.toThrow('Work not found.');
  });
});

describe('commitWorkSplit', () => {
  const items = [
    { title: 'Book a massage for Tree', rawText: 'Book a massage for Tree.' },
    { title: 'Order new sheets for Tree', rawText: 'Get her new sheets.' },
    { title: 'Reserve dinner for Tree', rawText: 'Reserve her something for dinner.' },
  ];

  test('creates children first, then provenance, then release, then plans', async () => {
    const sequence: string[] = [];
    let created = 0;
    const mutate = mock(async (_fn: any, args: any) => {
      if (args.externalId) {
        sequence.push(`create:${args.externalId}`);
        created += 1;
        expect(args.areaId).toBe('area-personal');
        return { workId: `child-${created}`, changed: true };
      }
      if (args.sourceKind === 'manual') {
        sequence.push('provenance');
        return 'evidence-1';
      }
      sequence.push('release');
      expect(args.reason).toContain('Split into:');
      return { releasedAt: 1 };
    });
    const advance = mock(async (args: any) => {
      sequence.push(`plan:${args.workId}`);
      return { status: 'ready' };
    });
    const result = await commitWorkSplit(
      { userId: 'user-1', workId: 'work-blob', items },
      {
        query: mock(async () => detail) as any,
        mutate: mutate as any,
        advance: advance as any,
        nowMs: () => 0,
      },
    );
    expect(result.workIds).toEqual(['child-1', 'child-2', 'child-3']);
    expect(sequence).toEqual([
      'create:split:work-blob:book-a-massage-for-tree',
      'create:split:work-blob:order-new-sheets-for-tree',
      'create:split:work-blob:reserve-dinner-for-tree',
      'provenance',
      'release',
      'plan:child-1',
      'plan:child-2',
      'plan:child-3',
    ]);
  });

  test('a child creation failure leaves the parent open', async () => {
    const calls: string[] = [];
    const mutate = mock(async (_fn: any, args: any) => {
      if (args.externalId) throw new Error('convex down');
      calls.push(args.sourceKind === 'manual' ? 'provenance' : 'release');
      return undefined;
    });
    await expect(
      commitWorkSplit(
        { userId: 'user-1', workId: 'work-blob', items },
        { query: mock(async () => detail) as any, mutate: mutate as any },
      ),
    ).rejects.toThrow('convex down');
    expect(calls).toEqual([]);
  });

  test('refuses a settled parent', async () => {
    await expect(
      commitWorkSplit(
        { userId: 'user-1', workId: 'work-blob', items },
        {
          query: mock(async () => ({ work: { ...detail.work, workState: 'done' } })) as any,
          mutate: mock(async () => undefined) as any,
        },
      ),
    ).rejects.toThrow('This Work is already settled.');
  });

  test('refuses fewer than two children', async () => {
    await expect(
      commitWorkSplit(
        { userId: 'user-1', workId: 'work-blob', items: items.slice(0, 1) },
        { query: mock(async () => detail) as any, mutate: mock(async () => undefined) as any },
      ),
    ).rejects.toThrow('A split needs between 2 and 6 Works.');
  });

  test('planning stops at the budget but every child is still created', async () => {
    let created = 0;
    const mutate = mock(async (_fn: any, args: any) => {
      if (args.externalId) {
        created += 1;
        return { workId: `child-${created}`, changed: true };
      }
      return undefined;
    });
    const advance = mock(async () => ({ status: 'ready' }));
    const clock = [0, 0, 500_000_000];
    const result = await commitWorkSplit(
      { userId: 'user-1', workId: 'work-blob', items },
      {
        query: mock(async () => detail) as any,
        mutate: mutate as any,
        advance: advance as any,
        nowMs: () => clock.shift() ?? 500_000_000,
      },
    );
    expect(result.workIds).toHaveLength(3);
    expect(advance).toHaveBeenCalledTimes(1);
  });
});
