import { describe, expect, test } from 'bun:test';
import { classificationFreshnessPatch, classifyCorpusThread } from '../convex/smart';

const row = (overrides: Record<string, unknown> = {}) => ({
  providerThreadId: 'thread_1',
  subject: 'Your verification code is 123456',
  fromAddress: 'Security <no-reply@example.com>',
  snippet: 'Use 123456 to sign in.',
  labels: ['INBOX', 'UNREAD'],
  unread: true,
  ...overrides,
});

describe('per-message Smart Category model queue', () => {
  test('a changed latest message resets both classifiers, while an idempotent sync does not', () => {
    expect(classificationFreshnessPatch('message_1', 'message_1')).toEqual({});
    expect(classificationFreshnessPatch('message_1', 'message_2')).toEqual({
      llmCategory: undefined,
      llmClassifiedAt: undefined,
      llmClassifiedMessageId: undefined,
      areaClassifierVersion: undefined,
      areaClassifiedAt: undefined,
      areaClassifiedMessageId: undefined,
      areaRoutingPending: true,
    });
  });

  test('even an obvious deterministic category is queued for the lightweight model', () => {
    const result = classifyCorpusThread(row(), { rules: [], customLabels: [] }, 'Use 123456 to sign in.');
    expect(result.smartPrimary).toBeTruthy();
    expect(result.llmPending).toBe(true);
  });

  test('a verdict for the current message closes pending while preserving live unread attention', () => {
    const result = classifyCorpusThread(
      row({
        latestMessageId: 'message_2',
        llmClassifiedMessageId: 'message_2',
        llmCategory: {
          primary: 'codes',
          secondary: [],
          customLabels: [],
          ruleHits: [],
          confidence: 0.99,
          needsAttention: true,
          model: 'nano',
        },
      }),
      { rules: [], customLabels: [] },
      'Use 123456 to sign in.',
    );
    expect(result.llmPending).toBeUndefined();
    expect(result.smartCategory.needsAttention).toBe(true);
  });

  test('rejects a stale verdict for an older message and reopens pending', () => {
    const result = classifyCorpusThread(
      row({
        latestMessageId: 'message_2',
        llmClassifiedMessageId: 'message_1',
        llmCategory: {
          primary: 'finance_admin',
          secondary: [],
          customLabels: [],
          ruleHits: [],
          confidence: 0.99,
          needsAttention: false,
          model: 'nano',
        },
      }),
      { rules: [], customLabels: [] },
      'Use 123456 to sign in.',
    );
    expect(result.llmPending).toBe(true);
    expect(result.smartPrimary).not.toBe('finance_admin');
  });
});
