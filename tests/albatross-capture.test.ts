import { describe, expect, test } from 'bun:test';
import {
  CAPTURE_BUTTON_LABEL,
  type CaptureState,
  looksLikeMultipleIntents,
  nextCaptureState,
  requestPipBeforePersist,
  resolveCapturePieces,
  splitIntentText,
} from '../components/albatross/IntentCapture';

describe('the capture launcher name', () => {
  // It used to rotate through five labels, so the most important control in
  // the product had no fixed name and its accessible name drifted from the
  // visible one.
  test('is one stable phrase', () => {
    expect(CAPTURE_BUTTON_LABEL).toBe('Get this off my mind');
  });

  test('does not describe the object as a task, an idea, or work', () => {
    expect(CAPTURE_BUTTON_LABEL.toLowerCase()).not.toContain('idea');
    expect(CAPTURE_BUTTON_LABEL.toLowerCase()).not.toContain('work');
    expect(CAPTURE_BUTTON_LABEL.toLowerCase()).not.toContain('task');
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

describe('capture persistence ordering', () => {
  test('requests PiP before beginning persistence', () => {
    const order: string[] = [];
    requestPipBeforePersist(
      () => {
        order.push('pip');
        return Promise.resolve();
      },
      () => order.push('persist'),
    );
    expect(order).toEqual(['pip', 'persist']);
  });

  test('a synchronous PiP denial never drops the capture', () => {
    let persisted = false;
    requestPipBeforePersist(
      () => {
        throw new Error('denied');
      },
      () => {
        persisted = true;
      },
    );
    expect(persisted).toBe(true);
  });
});
