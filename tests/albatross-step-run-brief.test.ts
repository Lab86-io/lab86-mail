import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { featuredWorkIds, startBriefStepRuns } from '../lib/albatross/step-run-brief';

let errorSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  errorSpy = spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  errorSpy.mockRestore();
});

const albatross = {
  dailyAlignment: { localDate: '2026-10-07', work: [{ id: 'work-plan' }, { id: 'work-shared' }] },
  activeIntents: [
    { id: 'work-shared', text: 'Shared' },
    { id: 'work-intent', text: 'Intent' },
  ],
} as any;

describe('featuredWorkIds', () => {
  test('puts the tomorrow plan first, then the active intents, without repeats', () => {
    expect(featuredWorkIds(albatross)).toEqual(['work-plan', 'work-shared', 'work-intent']);
  });

  test('drops empty and non-string ids', () => {
    expect(
      featuredWorkIds({
        dailyAlignment: { localDate: 'x', work: [{ id: '' }, { id: 7 }] },
        activeIntents: [{ id: null }, { id: 'work-1' }],
      } as any),
    ).toEqual(['work-1']);
  });

  test('a missing context has no ids', () => {
    expect(featuredWorkIds(null)).toEqual([]);
    expect(featuredWorkIds(undefined)).toEqual([]);
    expect(featuredWorkIds({})).toEqual([]);
  });
});

describe('startBriefStepRuns', () => {
  const report = { sections: { albatross } };

  test('only the morning edition starts runs', async () => {
    const start = mock(async () => ({ started: ['run-1'], reasons: {} }));
    expect(await startBriefStepRuns('user-1', 'evening', report, start)).toEqual({ started: [] });
    expect(await startBriefStepRuns('user-1', undefined, report, start)).toEqual({ started: [] });
    expect(start).not.toHaveBeenCalled();
  });

  test('an edition without featured Work starts nothing', async () => {
    const start = mock(async () => ({ started: ['run-1'], reasons: {} }));
    expect(await startBriefStepRuns('user-1', 'morning', { sections: {} }, start)).toEqual({ started: [] });
    expect(await startBriefStepRuns('user-1', 'morning', null, start)).toEqual({ started: [] });
    expect(start).not.toHaveBeenCalled();
  });

  test('passes the featured Work with the brief trigger', async () => {
    const start = mock(async () => ({ started: ['run-1'], reasons: { 'work-plan': 'not_runnable' } }));
    const result = await startBriefStepRuns('user-1', 'morning', report, start);
    expect(start).toHaveBeenCalledWith({
      userId: 'user-1',
      workIds: ['work-plan', 'work-shared', 'work-intent'],
      trigger: 'brief',
    });
    expect(result).toEqual({ started: ['run-1'], reasons: { 'work-plan': 'not_runnable' } });
  });

  test('a start that throws never fails the Brief', async () => {
    const start = mock(async () => {
      throw new Error('Convex is down');
    });
    expect(await startBriefStepRuns('user-1', 'morning', report, start)).toEqual({ started: [] });
    expect(errorSpy).toHaveBeenCalledWith('[brief jobs] step runs failed to start', 'user-1');
  });
});
