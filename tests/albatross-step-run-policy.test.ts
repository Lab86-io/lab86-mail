import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  automaticStepRunsEnabledFor,
  DEFAULT_STEP_RUN_COST_BUDGET_USD,
  DEFAULT_STEP_RUN_TIME_BUDGET_MS,
  isAutomaticTrigger,
  type RunnableStepLike,
  stepAcceptsTrigger,
  stepRunFeature,
  stepRunLimits,
  stepRunsEnabled,
} from '../lib/albatross/step-run-policy';

const ENV_KEYS = ['LAB86_STEP_RUNS', 'LAB86_STEP_RUNS_AUTO'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('stepRunsEnabled', () => {
  test('on unless the switch says off', () => {
    expect(stepRunsEnabled({})).toBe(true);
    expect(stepRunsEnabled({ LAB86_STEP_RUNS: 'on' })).toBe(true);
    expect(stepRunsEnabled({ LAB86_STEP_RUNS: 'off' })).toBe(false);
    expect(stepRunsEnabled({ LAB86_STEP_RUNS: ' OFF ' })).toBe(false);
  });

  test('reads process.env by default', () => {
    process.env.LAB86_STEP_RUNS = 'off';
    expect(stepRunsEnabled()).toBe(false);
    delete process.env.LAB86_STEP_RUNS;
    expect(stepRunsEnabled()).toBe(true);
  });
});

describe('automaticStepRunsEnabledFor', () => {
  test('off when unset or empty', () => {
    expect(automaticStepRunsEnabledFor('user-1', {})).toBe(false);
    expect(automaticStepRunsEnabledFor('user-1', { LAB86_STEP_RUNS_AUTO: '   ' })).toBe(false);
  });

  test('all turns it on for every user', () => {
    expect(automaticStepRunsEnabledFor('user-1', { LAB86_STEP_RUNS_AUTO: ' ALL ' })).toBe(true);
  });

  test('a list turns it on only for the listed users', () => {
    const env = { LAB86_STEP_RUNS_AUTO: 'user-1, user-2 ,,' };
    expect(automaticStepRunsEnabledFor('user-2', env)).toBe(true);
    expect(automaticStepRunsEnabledFor('user-3', env)).toBe(false);
    expect(automaticStepRunsEnabledFor('', env)).toBe(false);
  });

  test('the feature switch off wins over the list', () => {
    expect(
      automaticStepRunsEnabledFor('user-1', { LAB86_STEP_RUNS: 'off', LAB86_STEP_RUNS_AUTO: 'all' }),
    ).toBe(false);
  });

  test('reads process.env by default', () => {
    delete process.env.LAB86_STEP_RUNS;
    process.env.LAB86_STEP_RUNS_AUTO = 'user-9';
    expect(automaticStepRunsEnabledFor('user-9')).toBe(true);
    expect(automaticStepRunsEnabledFor('user-1')).toBe(false);
  });
});

describe('stepRunLimits', () => {
  test('defaults are 15 minutes and $5', () => {
    expect(DEFAULT_STEP_RUN_TIME_BUDGET_MS).toBe(900_000);
    expect(DEFAULT_STEP_RUN_COST_BUDGET_USD).toBe(5);
    expect(stepRunLimits({})).toEqual({ timeBudgetMs: 900_000, costBudgetUsd: 5 });
  });

  test('positive env values override the defaults', () => {
    expect(
      stepRunLimits({ LAB86_STEP_RUN_TIME_BUDGET_MS: '60000', LAB86_STEP_RUN_COST_BUDGET_USD: '2.5' }),
    ).toEqual({ timeBudgetMs: 60_000, costBudgetUsd: 2.5 });
  });

  test('invalid, zero, negative, and infinite values fall back', () => {
    for (const value of ['abc', '0', '-5', '', 'Infinity'])
      expect(
        stepRunLimits({ LAB86_STEP_RUN_TIME_BUDGET_MS: value, LAB86_STEP_RUN_COST_BUDGET_USD: value }),
      ).toEqual({ timeBudgetMs: 900_000, costBudgetUsd: 5 });
  });

  test('reads process.env by default', () => {
    expect(stepRunLimits()).toEqual(stepRunLimits(process.env));
  });
});

describe('triggers', () => {
  test('the Brief and the conductor are automatic', () => {
    expect(isAutomaticTrigger('brief')).toBe(true);
    expect(isAutomaticTrigger('conductor')).toBe(true);
    expect(isAutomaticTrigger('user')).toBe(false);
    expect(isAutomaticTrigger('resume')).toBe(false);
  });

  test('the feature splits user runs from automatic runs', () => {
    expect(stepRunFeature('user')).toBe('albatross_step');
    expect(stepRunFeature('resume')).toBe('albatross_step');
    expect(stepRunFeature('brief')).toBe('albatross_step_auto');
    expect(stepRunFeature('conductor')).toBe('albatross_step_auto');
  });
});

describe('stepAcceptsTrigger', () => {
  const step = (overrides: Partial<RunnableStepLike> = {}): RunnableStepLike => ({
    key: 'step-1',
    title: 'Draft the letter',
    done: false,
    ...overrides,
  });

  test('a done step accepts no trigger', () => {
    for (const trigger of ['user', 'resume', 'brief', 'conductor'] as const)
      expect(stepAcceptsTrigger(step({ done: true, stepMode: 'agent_does' }), trigger)).toBe(false);
  });

  test('automatic triggers need agent_does or agent_drafts', () => {
    expect(stepAcceptsTrigger(step({ stepMode: 'agent_does' }), 'brief')).toBe(true);
    expect(stepAcceptsTrigger(step({ stepMode: 'agent_drafts' }), 'conductor')).toBe(true);
    expect(stepAcceptsTrigger(step({ stepMode: 'you_do_observed' }), 'brief')).toBe(false);
    expect(stepAcceptsTrigger(step({ stepMode: 'you_do_offline' }), 'conductor')).toBe(false);
    expect(stepAcceptsTrigger(step(), 'brief')).toBe(false);
  });

  test('the user may hand over every digital step but you_do_offline', () => {
    expect(stepAcceptsTrigger(step({ stepMode: 'agent_does' }), 'user')).toBe(true);
    expect(stepAcceptsTrigger(step({ stepMode: 'agent_drafts' }), 'user')).toBe(true);
    expect(stepAcceptsTrigger(step({ stepMode: 'you_do_observed' }), 'user')).toBe(true);
    expect(stepAcceptsTrigger(step({ stepMode: 'you_do_offline' }), 'user')).toBe(false);
    expect(stepAcceptsTrigger(step({ stepMode: 'you_do_offline' }), 'resume')).toBe(false);
  });

  test('a step without a mode is refused only when it is physical', () => {
    expect(stepAcceptsTrigger(step({ kind: 'physical' }), 'user')).toBe(false);
    expect(stepAcceptsTrigger(step({ kind: 'digital' }), 'user')).toBe(true);
    expect(stepAcceptsTrigger(step({ kind: null, stepMode: null }), 'user')).toBe(true);
    expect(stepAcceptsTrigger(step({ kind: 'physical', stepMode: 'not-a-mode' }), 'user')).toBe(false);
  });
});
