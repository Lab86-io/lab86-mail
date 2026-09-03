import { describe, expect, test } from 'bun:test';
import { selectExecutionSnapshot } from '../lib/albatross/execution';
import { isStale, STALE_AFTER_DAYS } from '../lib/albatross/forgiveness';
import {
  DEFAULT_WORK_SHAPE,
  resolveShape,
  SHAPE_MEANING,
  SHAPE_POLICY,
  shapeAllows,
  shapeDetail,
  shapePlans,
  shapeVerifies,
} from '../lib/albatross/shape-policy';
import { WORK_SHAPE_GUIDE, WORK_SHAPES } from '../lib/albatross/work-shape';

const DAY = 24 * 60 * 60_000;
const NOW = Date.parse('2026-09-03T12:00:00Z');

describe('the shape policy table', () => {
  test('matches the round document exactly', () => {
    expect(SHAPE_POLICY).toEqual({
      quick: {
        plans: 'yes',
        verifies: 'yes',
        staleAfterDays: 14,
        mailWatch: true,
        staleness: true,
        missedMove: true,
        detail: 'guided',
      },
      list: {
        plans: 'no',
        verifies: 'no',
        staleAfterDays: null,
        mailWatch: false,
        staleness: false,
        missedMove: false,
        detail: 'list',
      },
      project: {
        plans: 'milestones',
        verifies: 'artifacts',
        staleAfterDays: 45,
        mailWatch: false,
        staleness: true,
        missedMove: false,
        detail: 'milestones',
      },
      practice: {
        plans: 'no',
        verifies: 'metric',
        staleAfterDays: null,
        mailWatch: false,
        staleness: false,
        missedMove: false,
        detail: 'practice',
      },
      decision: {
        plans: 'options',
        verifies: 'choice',
        staleAfterDays: 21,
        mailWatch: false,
        staleness: true,
        missedMove: false,
        detail: 'decision',
      },
      monitor: {
        plans: 'no',
        verifies: 'condition',
        staleAfterDays: null,
        mailWatch: true,
        staleness: false,
        missedMove: false,
        detail: 'monitor',
      },
      recurring: {
        plans: 'no',
        verifies: 'run',
        staleAfterDays: null,
        mailWatch: false,
        staleness: false,
        missedMove: false,
        detail: 'routine',
      },
    });
  });

  test('every shape has a policy row, a meaning line, and a guide line', () => {
    expect(WORK_SHAPES).toContain('list');
    for (const shape of WORK_SHAPES) {
      expect(SHAPE_POLICY[shape]).toBeDefined();
      expect(SHAPE_MEANING[shape].length).toBeGreaterThan(8);
      expect(WORK_SHAPE_GUIDE).toContain(`- ${shape}:`);
    }
    expect(WORK_SHAPE_GUIDE).toContain('movie list');
  });

  test('STALE_AFTER_DAYS is derived from the policy', () => {
    for (const shape of WORK_SHAPES) {
      expect(STALE_AFTER_DAYS[shape]).toBe(SHAPE_POLICY[shape].staleAfterDays);
    }
  });
});

describe('the policy helpers', () => {
  test('resolve unknown and missing shapes to the default', () => {
    expect(DEFAULT_WORK_SHAPE).toBe('quick');
    expect(resolveShape(undefined)).toBe('quick');
    expect(resolveShape(null)).toBe('quick');
    expect(resolveShape('banana')).toBe('quick');
    expect(resolveShape('list')).toBe('list');
  });

  test('shapeAllows reads the pass columns', () => {
    expect(shapeAllows('list', 'mailWatch')).toBe(false);
    expect(shapeAllows('list', 'staleness')).toBe(false);
    expect(shapeAllows('list', 'missedMove')).toBe(false);
    expect(shapeAllows('monitor', 'mailWatch')).toBe(true);
    expect(shapeAllows('project', 'staleness')).toBe(true);
    expect(shapeAllows('project', 'missedMove')).toBe(false);
    expect(shapeAllows(undefined, 'missedMove')).toBe(true);
  });

  test('shapePlans, shapeVerifies, and shapeDetail read their columns', () => {
    expect(shapePlans('list')).toBe('no');
    expect(shapePlans('project')).toBe('milestones');
    expect(shapePlans('decision')).toBe('options');
    expect(shapeVerifies('practice')).toBe('metric');
    expect(shapeDetail('recurring')).toBe('routine');
    expect(shapeDetail(undefined)).toBe('guided');
  });
});

describe('staleness per shape', () => {
  const row = (shape: string | undefined, ageDays: number) => ({
    shape: shape as any,
    workState: 'active',
    updatedAt: NOW - ageDays * DAY,
  });

  test('a shape with null days is never stale', () => {
    for (const shape of ['list', 'practice', 'monitor', 'recurring'] as const) {
      expect(isStale(row(shape, 400), NOW)).toBe(false);
    }
  });

  test('a shape with a number of days is stale after them', () => {
    expect(isStale(row('quick', 15), NOW)).toBe(true);
    expect(isStale(row('quick', 13), NOW)).toBe(false);
    expect(isStale(row('project', 46), NOW)).toBe(true);
    expect(isStale(row('project', 44), NOW)).toBe(false);
    expect(isStale(row('decision', 22), NOW)).toBe(true);
  });
});

describe('missed moves per shape', () => {
  const passed = (id: string, shape?: string) => ({
    _id: id,
    shape,
    rawText: id,
    status: 'applied',
    workState: 'active',
    openQuestions: 0,
    updatedAt: NOW,
    nextStep: 'Do the thing',
    scheduledStartAt: NOW - 2 * 3_600_000,
    scheduledEndAt: NOW - 3_600_000,
  });

  test('a passed block on a quick Work is a missed move; on a project it is not', () => {
    const snapshot = selectExecutionSnapshot(
      [passed('quick-1', 'quick'), passed('project-1', 'project')],
      NOW,
    );
    expect(snapshot.missedMoves.map((move) => move.workId)).toEqual(['quick-1']);
    // The project is not asked about, and its step is simply the next move.
    expect(snapshot.currentMove?.workId).toBe('project-1');
    expect(snapshot.currentMove?.phase).toBe('unscheduled');
  });

  test('an unshaped legacy row keeps the missed-move behavior', () => {
    const snapshot = selectExecutionSnapshot([passed('legacy-1')], NOW);
    expect(snapshot.missedMoves.map((move) => move.workId)).toEqual(['legacy-1']);
  });
});
