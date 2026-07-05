import { describe, expect, test } from 'bun:test';
import {
  type AppliedPlanStep,
  injectPlanArtifactRuntime,
  PLAN_ARTIFACT_MESSAGE_SOURCE,
  PLAN_ARTIFACT_RUNTIME_JS,
  parseToggleStepMessage,
  stepStatesForArtifact,
  toggleStepDecision,
} from '../lib/albatross/plan-artifact-runtime';

const STEPS: AppliedPlanStep[] = [
  { stepKey: 'step-1', kind: 'task', cardId: 'card_a' },
  { stepKey: 'step-2', kind: 'calendar_event' },
  { stepKey: 'step-3', kind: 'task', cardId: 'card_b' },
];

describe('injectPlanArtifactRuntime', () => {
  test('injects the runtime before </body>', () => {
    const out = injectPlanArtifactRuntime('<html><body><p>plan</p></body></html>');
    const scriptAt = out.indexOf('<script id="lab86-plan-runtime-js">');
    const bodyCloseAt = out.indexOf('</body>');
    expect(scriptAt).toBeGreaterThan(-1);
    expect(bodyCloseAt).toBeGreaterThan(scriptAt);
  });

  test('is idempotent: re-injecting replaces the previous copy', () => {
    const once = injectPlanArtifactRuntime('<html><body>x</body></html>');
    const twice = injectPlanArtifactRuntime(once);
    expect(twice.match(/lab86-plan-runtime-js/g)?.length).toBe(once.match(/lab86-plan-runtime-js/g)?.length);
  });

  test('appends when there is no </body> and passes empty html through', () => {
    expect(injectPlanArtifactRuntime('<div>fragment</div>')).toContain('lab86-plan-runtime-js');
    expect(injectPlanArtifactRuntime('')).toBe('');
  });

  test('runtime carries the full deterministic contract', () => {
    // Click delegation + artifact source tag.
    expect(PLAN_ARTIFACT_RUNTIME_JS).toContain("closest&&e.target.closest('[data-action]')");
    expect(PLAN_ARTIFACT_RUNTIME_JS).toContain(`source:'${PLAN_ARTIFACT_MESSAGE_SOURCE}'`);
    // Host step_state listener + strike-off class + done count.
    expect(PLAN_ARTIFACT_RUNTIME_JS).toContain("d.type==='step_state'");
    expect(PLAN_ARTIFACT_RUNTIME_JS).toContain('plan-step-done');
    expect(PLAN_ARTIFACT_RUNTIME_JS).toContain('data-plan-done-count');
    // Quiet inline hint (sentence case, no alert) for unapplied plans.
    expect(PLAN_ARTIFACT_RUNTIME_JS).toContain('Apply the plan to activate');
    expect(PLAN_ARTIFACT_RUNTIME_JS).not.toContain('alert(');
    // Reduced motion honored inside the frame.
    expect(PLAN_ARTIFACT_RUNTIME_JS).toContain('prefers-reduced-motion:reduce');
  });
});

describe('parseToggleStepMessage (host allowlist)', () => {
  test('accepts a well-formed toggle_step message', () => {
    expect(
      parseToggleStepMessage({
        source: 'lab86-plan-artifact',
        action: 'toggle_step',
        payload: { stepKey: 'step-2' },
      }),
    ).toEqual({ stepKey: 'step-2' });
  });

  test('rejects wrong sources, unknown actions, and malformed payloads', () => {
    expect(parseToggleStepMessage(null)).toBeNull();
    expect(parseToggleStepMessage('toggle_step')).toBeNull();
    expect(
      parseToggleStepMessage({
        source: 'lab86-daily-report',
        action: 'toggle_step',
        payload: { stepKey: 'x' },
      }),
    ).toBeNull();
    expect(
      parseToggleStepMessage({ source: 'lab86-plan-artifact', action: 'archive_thread', payload: {} }),
    ).toBeNull();
    expect(parseToggleStepMessage({ source: 'lab86-plan-artifact', action: 'toggle_step' })).toBeNull();
    expect(
      parseToggleStepMessage({
        source: 'lab86-plan-artifact',
        action: 'toggle_step',
        payload: { stepKey: 9 },
      }),
    ).toBeNull();
    expect(
      parseToggleStepMessage({
        source: 'lab86-plan-artifact',
        action: 'toggle_step',
        payload: { stepKey: '   ' },
      }),
    ).toBeNull();
    expect(
      parseToggleStepMessage({
        source: 'lab86-plan-artifact',
        action: 'toggle_step',
        payload: { stepKey: 'k'.repeat(200) },
      }),
    ).toBeNull();
  });
});

describe('stepStatesForArtifact', () => {
  test('maps card-backed steps to completion booleans; card-less steps are omitted', () => {
    const states = stepStatesForArtifact(STEPS, [
      { cardId: 'card_a', completedAt: 123 },
      { cardId: 'card_b', completedAt: null },
    ]);
    expect(states).toEqual([
      { stepKey: 'step-1', completed: true },
      { stepKey: 'step-3', completed: false },
    ]);
  });

  test('a step whose card state is missing reads as not completed', () => {
    expect(stepStatesForArtifact(STEPS, [])).toEqual([
      { stepKey: 'step-1', completed: false },
      { stepKey: 'step-3', completed: false },
    ]);
  });
});

describe('toggleStepDecision', () => {
  const cardStates = [{ cardId: 'card_a', completedAt: 500 }];

  test('unapplied plan -> not_applied (the quiet hint path)', () => {
    expect(toggleStepDecision({ applied: false, steps: STEPS, cardStates, stepKey: 'step-1' })).toEqual({
      kind: 'not_applied',
    });
  });

  test('unknown stepKey or card-less step -> unknown_step', () => {
    expect(toggleStepDecision({ applied: true, steps: STEPS, cardStates, stepKey: 'step-99' })).toEqual({
      kind: 'unknown_step',
    });
    // step-2 is a calendar event with no board card behind it.
    expect(toggleStepDecision({ applied: true, steps: STEPS, cardStates, stepKey: 'step-2' })).toEqual({
      kind: 'unknown_step',
    });
  });

  test('completed card toggles back open (completedAt null)', () => {
    expect(toggleStepDecision({ applied: true, steps: STEPS, cardStates, stepKey: 'step-1' }, 999)).toEqual({
      kind: 'toggle',
      cardId: 'card_a',
      nextCompletedAt: null,
    });
  });

  test('open card toggles to completed at the provided time', () => {
    expect(toggleStepDecision({ applied: true, steps: STEPS, cardStates, stepKey: 'step-3' }, 999)).toEqual({
      kind: 'toggle',
      cardId: 'card_b',
      nextCompletedAt: 999,
    });
  });
});
