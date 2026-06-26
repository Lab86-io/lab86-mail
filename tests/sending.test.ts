import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_UNDO_SEND_SECONDS,
  MAX_UNDO_SEND_SECONDS,
  normalizeUndoSendSeconds,
  UNDO_SEND_CHOICES,
} from '../lib/shared/sending';

describe('normalizeUndoSendSeconds', () => {
  test('defaults invalid values', () => {
    expect(normalizeUndoSendSeconds(undefined)).toBe(DEFAULT_UNDO_SEND_SECONDS);
    expect(normalizeUndoSendSeconds('abc')).toBe(DEFAULT_UNDO_SEND_SECONDS);
    expect(normalizeUndoSendSeconds(-5)).toBe(DEFAULT_UNDO_SEND_SECONDS);
  });
  test('caps at the maximum undo window', () => {
    expect(normalizeUndoSendSeconds(999)).toBe(MAX_UNDO_SEND_SECONDS);
    expect(normalizeUndoSendSeconds(30)).toBe(30);
    expect(normalizeUndoSendSeconds(0)).toBe(0);
  });
});

describe('UNDO_SEND_CHOICES', () => {
  test('includes instant and max options', () => {
    expect(UNDO_SEND_CHOICES.some((choice) => choice.value === 0)).toBe(true);
    expect(UNDO_SEND_CHOICES.some((choice) => choice.value === MAX_UNDO_SEND_SECONDS)).toBe(true);
  });
});
