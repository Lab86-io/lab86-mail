import { describe, expect, test } from 'bun:test';
import {
  CAPTURE_BUTTON_LABELS,
  type CaptureState,
  looksLikeMultipleIntents,
  nextCaptureState,
  resolveCapturePieces,
  rotatingLabelAt,
  splitIntentText,
} from '../components/albatross/IntentCapture';

describe('rotatingLabelAt', () => {
  test('cycles deterministically through the label set', () => {
    for (let i = 0; i < CAPTURE_BUTTON_LABELS.length; i += 1) {
      expect(rotatingLabelAt(i)).toBe(CAPTURE_BUTTON_LABELS[i]);
    }
  });

  test('wraps past the end of the set', () => {
    expect(rotatingLabelAt(CAPTURE_BUTTON_LABELS.length)).toBe(CAPTURE_BUTTON_LABELS[0]);
    expect(rotatingLabelAt(CAPTURE_BUTTON_LABELS.length * 3 + 2)).toBe(CAPTURE_BUTTON_LABELS[2]);
  });

  test('is negative-safe', () => {
    expect(rotatingLabelAt(-1)).toBe(CAPTURE_BUTTON_LABELS[CAPTURE_BUTTON_LABELS.length - 1]);
  });

  test('tick 0 matches the stable accessible name', () => {
    expect(rotatingLabelAt(0)).toBe('New Work');
  });
});

describe('nextCaptureState', () => {
  test('opens only from closed', () => {
    expect(nextCaptureState('closed', { type: 'open' })).toBe('editing');
    expect(nextCaptureState('editing', { type: 'open' })).toBe('editing');
    expect(nextCaptureState('saving', { type: 'open' })).toBe('saving');
  });

  test('submit routes single dumps straight to saving', () => {
    expect(nextCaptureState('editing', { type: 'submit', multi: false })).toBe('saving');
  });

  test('submit routes multi dumps to the split question first', () => {
    expect(nextCaptureState('editing', { type: 'submit', multi: true })).toBe('split');
  });

  test('split question resolves to saving on either choice', () => {
    expect(nextCaptureState('split', { type: 'split' })).toBe('saving');
    expect(nextCaptureState('split', { type: 'keep' })).toBe('saving');
  });

  test('back-to-editing works from split and discard', () => {
    expect(nextCaptureState('split', { type: 'edit' })).toBe('editing');
    expect(nextCaptureState('discard', { type: 'edit' })).toBe('editing');
  });

  test('dismiss closes immediately when empty, asks first when text exists', () => {
    expect(nextCaptureState('editing', { type: 'dismiss', hasText: false })).toBe('closed');
    expect(nextCaptureState('editing', { type: 'dismiss', hasText: true })).toBe('discard');
    expect(nextCaptureState('split', { type: 'dismiss', hasText: true })).toBe('discard');
    expect(nextCaptureState('discard', { type: 'dismiss', hasText: true })).toBe('closed');
  });

  test('confirmed discard closes', () => {
    expect(nextCaptureState('discard', { type: 'discard' })).toBe('closed');
  });

  test('saving cannot be dismissed and resolves via saved -> finish', () => {
    expect(nextCaptureState('saving', { type: 'dismiss', hasText: true })).toBe('saving');
    expect(nextCaptureState('saved', { type: 'dismiss', hasText: true })).toBe('saved');
    expect(nextCaptureState('saving', { type: 'saved' })).toBe('saved');
    expect(nextCaptureState('saved', { type: 'finish' })).toBe('closed');
  });

  test('save errors return to editing so the dump is not lost', () => {
    expect(nextCaptureState('saving', { type: 'error' })).toBe('editing');
  });

  test('stray events never move unrelated states', () => {
    const states: CaptureState[] = ['closed', 'editing', 'split', 'discard', 'saving', 'saved'];
    for (const state of states) {
      expect(nextCaptureState(state, { type: 'finish' })).toBe(state === 'saved' ? 'closed' : state);
      expect(nextCaptureState(state, { type: 'saved' })).toBe(state === 'saving' ? 'saved' : state);
    }
  });
});

describe('resolveCapturePieces', () => {
  test('keep returns a single end-trimmed piece', () => {
    expect(resolveCapturePieces('  renew passport  ', 'keep')).toEqual(['renew passport']);
  });

  test('keep preserves the dump verbatim beyond end trimming', () => {
    const raw = '  renew  passport...  ASAP!!  and taxes\nalso the shower idea ';
    expect(resolveCapturePieces(raw, 'keep')).toEqual([raw.trim()]);
  });

  test('split shapes each piece into its own intent', () => {
    const raw = 'renew passport\nfile taxes\ncall the dentist';
    expect(looksLikeMultipleIntents(raw)).toBe(true);
    expect(resolveCapturePieces(raw, 'split')).toEqual(['renew passport', 'file taxes', 'call the dentist']);
  });

  test('split matches splitIntentText exactly', () => {
    const raw = 'book flights; email landlord and then pack boxes';
    expect(resolveCapturePieces(raw, 'split')).toEqual(splitIntentText(raw.trim()));
  });

  test('single-thought dumps do not read as multiple intents', () => {
    const raw = 'that idea from the shower about the garden lights';
    expect(looksLikeMultipleIntents(raw)).toBe(false);
    expect(resolveCapturePieces(raw, 'split')).toEqual([raw]);
  });

  test('empty and whitespace-only dumps produce nothing to save', () => {
    expect(resolveCapturePieces('', 'keep')).toEqual([]);
    expect(resolveCapturePieces('   \n  ', 'split')).toEqual([]);
  });
});
