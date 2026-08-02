import { describe, expect, test } from 'bun:test';
import { filterWork, groupWork, type WorkListItem } from '../components/albatross/AlbatrossesSurface';

const row = (over: Partial<WorkListItem>): WorkListItem => ({
  _id: over._id || 'w1',
  title: over.title ?? 'Something',
  rawText: over.rawText ?? 'raw',
  status: over.status ?? 'ready',
  workState: over.workState ?? 'active',
  agentState: over.agentState ?? null,
  // `??` would swallow an explicit null, which is exactly the case under test.
  primaryAreaId: 'primaryAreaId' in over ? (over.primaryAreaId ?? null) : 'area_1',
  areaName: 'areaName' in over ? (over.areaName ?? null) : 'Money',
  openQuestions: over.openQuestions ?? 0,
  updatedAt: over.updatedAt ?? 1,
  createdAt: over.createdAt ?? 1,
});

describe('list filters', () => {
  const rows = [
    row({ _id: 'a', openQuestions: 2 }),
    row({ _id: 'b' }),
    row({ _id: 'c', primaryAreaId: null, areaName: null }),
    row({ _id: 'd', primaryAreaId: 'area_2', areaName: 'Home' }),
  ];

  test('everything is everything', () => {
    expect(filterWork(rows, 'all', null).map((r) => r._id)).toEqual(['a', 'b', 'c', 'd']);
  });

  test('needs you is the short list, not the whole list', () => {
    expect(filterWork(rows, 'needs_you', null).map((r) => r._id)).toEqual(['a']);
  });

  test('the old Unassigned queue is now a filter over the same rows', () => {
    // It used to be a route the shell never mounted, so its contents were
    // unreachable. As a filter it sits one click from the list it belongs to.
    expect(filterWork(rows, 'unhomed', null).map((r) => r._id)).toEqual(['c']);
  });

  test('an area narrows any filter', () => {
    expect(filterWork(rows, 'all', 'area_2').map((r) => r._id)).toEqual(['d']);
    expect(filterWork(rows, 'needs_you', 'area_2')).toEqual([]);
    expect(filterWork(rows, 'needs_you', 'area_1').map((r) => r._id)).toEqual(['a']);
  });
});

describe('list grouping', () => {
  test('needs-you leads, and finished trails', () => {
    const groups = groupWork([
      row({ _id: 'done', workState: 'done' }),
      row({ _id: 'waiting', workState: 'waiting' }),
      row({ _id: 'asks', openQuestions: 1 }),
    ]);
    expect(groups.map((g) => g.key)).toEqual(['needs_you', 'waiting', 'done']);
  });

  test('empty states never render as a heading with nothing under it', () => {
    const groups = groupWork([row({ _id: 'only' })]);
    expect(groups).toHaveLength(1);
    expect(groups[0].items).toHaveLength(1);
    for (const group of groups) expect(group.items.length).toBeGreaterThan(0);
  });

  test('a put-down Albatross with an open question groups as still asking', () => {
    const groups = groupWork([row({ _id: 'gold', workState: 'archived', openQuestions: 3 })]);
    expect(groups.map((g) => g.key)).toEqual(['unresolved']);
  });
});
