import { describe, expect, test } from 'bun:test';
import {
  celebrationTransition,
  orderProjectTasks,
  type ProjectStatus,
  projectGroups,
  projectProgress,
} from '../components/tasks/ProjectsLens';

function proj(status: ProjectStatus, updatedAt: number) {
  return { status, updatedAt };
}

describe('projectProgress', () => {
  test('computes done, total, fraction, and completeness', () => {
    expect(projectProgress({ taskCount: 8, completedTaskCount: 3 })).toEqual({
      done: 3,
      total: 8,
      fraction: 3 / 8,
      complete: false,
    });
    expect(projectProgress({ taskCount: 4, completedTaskCount: 4 })).toEqual({
      done: 4,
      total: 4,
      fraction: 1,
      complete: true,
    });
  });

  test('a project with no tasks is never complete', () => {
    expect(projectProgress({ taskCount: 0, completedTaskCount: 0 })).toEqual({
      done: 0,
      total: 0,
      fraction: 0,
      complete: false,
    });
  });

  test('clamps out-of-range counts instead of overflowing', () => {
    // completed > total (e.g. a task left the project after completing)
    expect(projectProgress({ taskCount: 3, completedTaskCount: 5 })).toEqual({
      done: 3,
      total: 3,
      fraction: 1,
      complete: true,
    });
    expect(projectProgress({ taskCount: 3, completedTaskCount: -1 }).done).toBe(0);
    expect(projectProgress({ taskCount: -2, completedTaskCount: 0 }).total).toBe(0);
  });
});

describe('projectGroups', () => {
  test('splits into active, paused, done — archived leaves the lens', () => {
    const projects = [
      proj('done', 10),
      proj('active', 20),
      proj('archived', 99),
      proj('paused', 30),
      proj('active', 40),
    ];
    const groups = projectGroups(projects);
    expect(groups.active.map((p) => p.updatedAt)).toEqual([40, 20]);
    expect(groups.paused.map((p) => p.updatedAt)).toEqual([30]);
    expect(groups.done.map((p) => p.updatedAt)).toEqual([10]);
    // Archived appears nowhere.
    expect([...groups.active, ...groups.paused, ...groups.done].some((p) => p.status === 'archived')).toBe(
      false,
    );
  });

  test('orders each group by most recent activity first', () => {
    const groups = projectGroups([proj('active', 1), proj('active', 3), proj('active', 2)]);
    expect(groups.active.map((p) => p.updatedAt)).toEqual([3, 2, 1]);
  });

  test('does not mutate the input list', () => {
    const projects = [proj('active', 1), proj('active', 2)];
    projectGroups(projects);
    expect(projects.map((p) => p.updatedAt)).toEqual([1, 2]);
  });
});

describe('celebrationTransition', () => {
  test('fires only on an observed incomplete-to-complete transition', () => {
    expect(celebrationTransition({ done: 3, total: 4 }, { done: 4, total: 4 })).toBe(true);
  });

  test('never fires on first load (no prior snapshot)', () => {
    expect(celebrationTransition(undefined, { done: 4, total: 4 })).toBe(false);
    expect(celebrationTransition(null, { done: 4, total: 4 })).toBe(false);
  });

  test('does not fire while still incomplete or when already complete', () => {
    expect(celebrationTransition({ done: 1, total: 4 }, { done: 2, total: 4 })).toBe(false);
    expect(celebrationTransition({ done: 4, total: 4 }, { done: 4, total: 4 })).toBe(false);
  });

  test('does not fire for an empty project (nothing was finished)', () => {
    expect(celebrationTransition({ done: 0, total: 1 }, { done: 0, total: 0 })).toBe(false);
  });

  test('fires when the last task is added-and-done in one update', () => {
    // 3/4 -> 5/5: total grew and everything landed done.
    expect(celebrationTransition({ done: 3, total: 4 }, { done: 5, total: 5 })).toBe(true);
  });
});

describe('orderProjectTasks', () => {
  test('open tasks first (due date ascending, undated after), done tasks sink', () => {
    const tasks = [
      { cardId: 'done-old', completedAt: 100, updatedAt: 100 },
      { cardId: 'open-undated', updatedAt: 50 },
      { cardId: 'open-due-late', dueAt: 900, updatedAt: 10 },
      { cardId: 'done-recent', completedAt: 200, updatedAt: 200 },
      { cardId: 'open-due-soon', dueAt: 300, updatedAt: 5 },
    ];
    expect(orderProjectTasks(tasks).map((t) => t.cardId)).toEqual([
      'open-due-soon',
      'open-due-late',
      'open-undated',
      'done-recent',
      'done-old',
    ]);
  });

  test('undated open tasks fall back to recency', () => {
    const tasks = [
      { cardId: 'stale', updatedAt: 1 },
      { cardId: 'fresh', updatedAt: 9 },
    ];
    expect(orderProjectTasks(tasks).map((t) => t.cardId)).toEqual(['fresh', 'stale']);
  });
});
