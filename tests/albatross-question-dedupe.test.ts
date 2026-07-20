import { describe, expect, test } from 'bun:test';
import {
  canonicalQuestionPrompt,
  questionDedupeKey,
  shouldAdvanceWorkAfterAnswer,
} from '../lib/albatross/question-dedupe';

describe('Albatross question deduplication', () => {
  test('ignores conversational lead-ins and punctuation', () => {
    expect(canonicalQuestionPrompt('Quick question: can you tell me what you finished today?')).toBe(
      canonicalQuestionPrompt('Tell me what you finished today.'),
    );
  });

  test('scopes equivalent asks to their durable target', () => {
    const first = questionDedupeKey({
      projectId: 'p1',
      kind: 'checkin',
      prompt: 'Quick question: can you tell me what you finished today?',
    });
    const equivalent = questionDedupeKey({
      projectId: 'p1',
      kind: 'checkin',
      prompt: 'Tell me what you finished today.',
    });

    expect(first).toBe(equivalent);
    expect(first).not.toBe(
      questionDedupeKey({
        projectId: 'p2',
        kind: 'checkin',
        prompt: 'Tell me what you finished today.',
      }),
    );
  });

  test('keeps materially different asks distinct', () => {
    expect(questionDedupeKey({ workId: 'w1', prompt: 'What did you finish today?' })).not.toBe(
      questionDedupeKey({ workId: 'w1', prompt: 'What is blocking you today?' }),
    );
  });

  test('preserves distinct non-Latin meaning in canonical keys', () => {
    expect(questionDedupeKey({ projectId: 'p1', prompt: '今日は何を終えましたか？' })).not.toBe(
      questionDedupeKey({ projectId: 'p1', prompt: '今日の障害は何ですか？' }),
    );
  });

  test('advances planning once for material answers but not a confirmed completion', () => {
    expect(shouldAdvanceWorkAfterAnswer('clarification', 'Next Friday')).toBe(true);
    expect(shouldAdvanceWorkAfterAnswer('completion', 'Not yet')).toBe(true);
    expect(shouldAdvanceWorkAfterAnswer('completion', 'Done')).toBe(false);
  });
});
