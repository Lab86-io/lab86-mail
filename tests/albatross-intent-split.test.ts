import { describe, expect, test } from 'bun:test';
import { looksLikeMultipleIntents, splitIntentText } from '../components/albatross/intent-split';

describe('intent capture split', () => {
  test('raw dumps split only when strong separators are present', () => {
    const text = 'File passport renewal\nCheck CardHunt onboarding; and then practice banjo';
    expect(looksLikeMultipleIntents(text)).toBe(true);
    expect(splitIntentText(text)).toEqual([
      'File passport renewal',
      'Check CardHunt onboarding',
      'practice banjo',
    ]);
    expect(splitIntentText('one loose thought without separators')).toEqual([
      'one loose thought without separators',
    ]);
    expect(looksLikeMultipleIntents('one loose thought without separators')).toBe(false);
  });

  test('lists split per item and repeated items collapse', () => {
    expect(splitIntentText('1. Call the bank\n2. Call the bank\n- Book the dentist')).toEqual([
      'Call the bank',
      'Book the dentist',
    ]);
    expect(splitIntentText('   ')).toEqual([]);
  });
});
