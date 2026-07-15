import { describe, expect, test } from 'bun:test';
import { matchAreaContext } from '@/lib/albatross/area-matching';

const areas = [
  {
    _id: 'area_albatross',
    name: 'Albatross',
    kind: 'software',
    description: 'The Lab86 mail assistant and its codebase.',
    primaryDomain: 'lab86.com',
  },
  { _id: 'area_house', name: 'Household', kind: 'personal', description: 'Repairs and utilities.' },
];

describe('proactive Area context matching', () => {
  test('recognizes GitHub notifications by repository/project context, not sender domain', () => {
    const match = matchAreaContext({
      text: '[Lab86-io/lab86-mail] area context PR was merged',
      areas: [{ _id: 'area_albatross', name: 'Workspace', primaryDomain: 'example.test' }],
      facts: [
        {
          _id: 'fact_repo',
          areaId: 'area_albatross',
          kind: 'repository',
          value: 'Lab86-io/lab86-mail',
          status: 'verified',
        },
      ],
    });
    expect(match).toMatchObject({ areaId: 'area_albatross', areaName: 'Workspace' });
    expect(match!.confidence).toBeGreaterThanOrEqual(0.7);
  });

  test('uses repository facts for commits, pull requests, and issues', () => {
    const match = matchAreaContext({
      text: 'commit 4f32 in Lab86-io/lab86-mail: fix area indexing',
      areas: [{ _id: 'area_albatross', name: 'Workspace', primaryDomain: 'example.test' }],
      facts: [
        {
          _id: 'fact_repo',
          areaId: 'area_albatross',
          kind: 'repository',
          value: 'Lab86-io/lab86-mail',
          status: 'verified',
        },
      ],
    });
    expect(match?.areaId).toBe('area_albatross');
    expect(match?.reason).toContain('repository');
  });

  test('does not force an assignment from generic prose or tied Areas', () => {
    expect(matchAreaContext({ text: 'Weekly project update', areas, facts: [] })).toBeNull();
    expect(
      matchAreaContext({
        text: 'lab86 release',
        areas: [
          { _id: 'area_one', name: 'Release one', primaryDomain: 'lab86.com' },
          { _id: 'area_two', name: 'Release two', primaryDomain: 'lab86.com' },
        ],
        facts: [],
      }),
    ).toBeNull();
  });
});
