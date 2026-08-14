import { describe, expect, test } from 'bun:test';
import { nextMoveLine } from '../components/albatross/primitives';

describe('Albatross next move copy', () => {
  test('trims a concrete next step and falls back for whitespace', () => {
    expect(nextMoveLine({ nextStep: '  Complete DS-82  ' })).toBe('Next: Complete DS-82');
    expect(nextMoveLine({ nextStep: '   ' })).toBe('Albatross is carrying this');
  });

  test('state messages take precedence over a next step', () => {
    expect(nextMoveLine({ openQuestions: 1, nextStep: 'Complete DS-82' })).toBe(
      'One question waiting for you',
    );
    expect(nextMoveLine({ agentState: 'error', nextStep: 'Complete DS-82' })).toBe(
      'Something went wrong — take a look',
    );
    expect(nextMoveLine({ workState: 'waiting', nextStep: 'Complete DS-82' })).toBe(
      'Waiting on somebody else',
    );
  });
});
