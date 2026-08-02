import { describe, expect, test } from 'bun:test';
import {
  isClosed,
  isUnresolved,
  needsYou,
  railWorkBadge,
  WORK_STATE_LABEL,
  WORK_STATE_ORDER,
  workStateKey,
} from '../lib/albatross/work-state';

describe('needsYou', () => {
  // The bug this replaces: the Areas pane said "0 active" while three real
  // questions about a live Albatross waited in a notification popover. Every
  // surface decided for itself what needed the user, and they disagreed.
  test('an open question needs the user', () => {
    expect(needsYou({ openQuestions: 1, workState: 'active' })).toBe(true);
    expect(needsYou({ openQuestions: 3, workState: 'active' })).toBe(true);
  });

  test('an agent that asked for input needs the user', () => {
    expect(needsYou({ agentState: 'needs_input' })).toBe(true);
  });

  test('a failed run needs a decision', () => {
    expect(needsYou({ agentState: 'error' })).toBe(true);
    expect(needsYou({ planError: 'plan generation failed' })).toBe(true);
  });

  test('work the system is doing does not need the user', () => {
    expect(needsYou({ agentState: 'researching', openQuestions: 0 })).toBe(false);
    expect(needsYou({ agentState: 'applying', openQuestions: 0 })).toBe(false);
    expect(needsYou({ workState: 'waiting', openQuestions: 0 })).toBe(false);
  });

  test('a closed Albatross never nags, even with an unanswered question', () => {
    // The user put it down. It must not claim a place in "Needs you", and the
    // rail badge must not count it.
    expect(needsYou({ workState: 'done', openQuestions: 2 })).toBe(false);
    expect(needsYou({ workState: 'archived', agentState: 'needs_input' })).toBe(false);
    expect(railWorkBadge([{ workState: 'archived', openQuestions: 3 }])).toBeNull();
  });
});

describe('workStateKey', () => {
  test('needs-you outranks whatever state the row carries', () => {
    expect(workStateKey({ workState: 'active', openQuestions: 1 })).toBe('needs_you');
    expect(workStateKey({ workState: 'waiting', agentState: 'needs_input' })).toBe('needs_you');
  });

  test('blocked reads as waiting — the user did not fail, something else did', () => {
    expect(workStateKey({ workState: 'blocked' })).toBe('waiting');
    expect(workStateKey({ workState: 'waiting' })).toBe('waiting');
  });

  test('closed states win over everything', () => {
    expect(workStateKey({ workState: 'done' })).toBe('done');
    expect(workStateKey({ workState: 'archived' })).toBe('archived');
    expect(isClosed({ workState: 'done' })).toBe(true);
  });

  test('closed but still asking is its own state, not a hidden one', () => {
    // Live data: an archived Albatross with three pending questions. Filing it
    // under "finished" is how those questions became unreachable.
    expect(workStateKey({ workState: 'archived', openQuestions: 3 })).toBe('unresolved');
    expect(workStateKey({ workState: 'done', openQuestions: 1 })).toBe('unresolved');
    expect(isUnresolved({ workState: 'archived', openQuestions: 3 })).toBe(true);
    expect(isUnresolved({ workState: 'archived', openQuestions: 0 })).toBe(false);
    expect(isUnresolved({ workState: 'active', openQuestions: 3 })).toBe(false);
  });

  test('an empty row is simply in progress', () => {
    expect(workStateKey({})).toBe('in_progress');
  });

  test('every state has a label and a place in the order', () => {
    for (const key of WORK_STATE_ORDER) {
      expect(WORK_STATE_LABEL[key]).toBeTruthy();
    }
    expect(WORK_STATE_ORDER[0]).toBe('needs_you');
    expect(WORK_STATE_ORDER.at(-1)).toBe('archived');
  });

  test('no label says overdue, late, or failed', () => {
    const words = Object.values(WORK_STATE_LABEL).join(' ').toLowerCase();
    expect(words).not.toContain('overdue');
    expect(words).not.toContain('late');
    expect(words).not.toContain('fail');
  });
});

describe('railWorkBadge', () => {
  // A count of open Albatrosses is a count of weights. The badge says what is
  // waiting, and says nothing when nothing is.
  test('says nothing when nothing needs the user', () => {
    expect(railWorkBadge([])).toBeNull();
    expect(railWorkBadge([{ workState: 'active' }, { workState: 'waiting' }])).toBeNull();
  });

  test('uses words, and counts only what needs the user', () => {
    expect(railWorkBadge([{ openQuestions: 1 }])).toBe('One needs you');
    expect(railWorkBadge([{ openQuestions: 1 }, { agentState: 'needs_input' }])).toBe('2 need you');
  });

  test('never reports the size of the whole list', () => {
    const items = [
      { openQuestions: 1 },
      { workState: 'active' },
      { workState: 'waiting' },
      { workState: 'done' },
    ];
    expect(railWorkBadge(items)).toBe('One needs you');
  });
});
