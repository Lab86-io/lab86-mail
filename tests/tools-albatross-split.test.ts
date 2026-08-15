import { afterEach, describe, expect, mock, test } from 'bun:test';
import {
  __setAlbatrossToolDepsForTest,
  albatrossSplitWork,
} from '../lib/tools/albatross';

const ctx = {
  userId: 'user-1',
  userEmail: 'u@example.com',
  userName: 'U',
  userTimezone: 'America/New_York',
} as any;

afterEach(() => {
  __setAlbatrossToolDepsForTest();
});

describe('albatross_split_work tool', () => {
  test('without items it proposes and instructs the agent to confirm first', async () => {
    const proposeWorkSplit = mock(async () => ({
      workTitle: 'Massage, sheets, dinner',
      items: [
        { title: 'Book a massage', rawText: 'Book a massage.' },
        { title: 'Order new sheets', rawText: 'Order new sheets.' },
      ],
    }));
    const commitWorkSplit = mock(async () => ({ workIds: [], releasedParent: false }));
    __setAlbatrossToolDepsForTest({
      proposeWorkSplit: proposeWorkSplit as any,
      commitWorkSplit: commitWorkSplit as any,
    });

    const result = await albatrossSplitWork.handler({ workId: 'work-1', focus: 'the sheets' }, ctx);

    expect(result.committed).toBe(false);
    expect(result.proposed).toHaveLength(2);
    expect(result.summary).toContain('commit only after the user confirms');
    expect(proposeWorkSplit).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', workId: 'work-1', focus: 'the sheets' }),
    );
    expect(commitWorkSplit).not.toHaveBeenCalled();
  });

  test('with items it commits and reports the released parent', async () => {
    const commitWorkSplit = mock(async () => ({
      workIds: ['child-1', 'child-2'],
      releasedParent: true,
    }));
    __setAlbatrossToolDepsForTest({ commitWorkSplit: commitWorkSplit as any });

    const result = await albatrossSplitWork.handler(
      {
        workId: 'work-1',
        items: [
          { title: 'Book a massage', rawText: 'Book a massage.' },
          { title: 'Order new sheets', rawText: 'Order new sheets.' },
        ],
      },
      ctx,
    );

    expect(result.committed).toBe(true);
    expect(result.workIds).toEqual(['child-1', 'child-2']);
    expect(result.summary).toContain('released with provenance');
    expect(commitWorkSplit).toHaveBeenCalledWith(
      expect.objectContaining({ workId: 'work-1', timezone: 'America/New_York' }),
    );
  });

  test('the tool is registered as mutating with a bounded input contract', () => {
    expect(albatrossSplitWork.name).toBe('albatross_split_work');
    expect(albatrossSplitWork.mutating).toBe(true);
    expect(() =>
      albatrossSplitWork.input.parse({ workId: 'work-1', items: [{ title: 'only one', rawText: 'x' }] }),
    ).toThrow();
  });
});
