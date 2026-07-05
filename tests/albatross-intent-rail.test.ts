import { describe, expect, test } from 'bun:test';
import {
  intentInitials,
  RAIL_COLLAPSED_PX,
  RAIL_EXPANDED_PX,
  railExpandTransition,
  railLabelMotion,
} from '../lib/albatross/intent-rail';

describe('intentInitials', () => {
  test('two words -> two initials', () => {
    expect(intentInitials('Renew passport')).toBe('RP');
    expect(intentInitials('upload nys taxes')).toBe('UN');
  });

  test('one word -> single initial', () => {
    expect(intentInitials('Taxes')).toBe('T');
  });

  test('ignores leading punctuation and extra whitespace', () => {
    expect(intentInitials("  'quick'   errand ")).toBe('QE');
    expect(intentInitials('— fix the sink')).toBe('FT');
  });

  test('digits and non-latin letters work', () => {
    expect(intentInitials('1099 forms')).toBe('1F');
    expect(intentInitials('école visit')).toBe('ÉV');
  });

  test('empty and nullish titles fall back to a middle dot', () => {
    expect(intentInitials('')).toBe('·');
    expect(intentInitials('   ')).toBe('·');
    expect(intentInitials(null)).toBe('·');
    expect(intentInitials(undefined)).toBe('·');
    expect(intentInitials('***')).toBe('·');
  });
});

describe('rail motion helpers', () => {
  test('collapsed rail is slim and the overlay is wide enough for labels', () => {
    expect(RAIL_COLLAPSED_PX).toBeLessThanOrEqual(64);
    expect(RAIL_EXPANDED_PX).toBeGreaterThanOrEqual(240);
  });

  test('expand transition is a spring, reduced motion is instant', () => {
    expect(railExpandTransition(false)).toMatchObject({ type: 'spring' });
    expect(railExpandTransition(true)).toEqual({ duration: 0 });
  });

  test('labels fade/slide in with a slight delay when expanding', () => {
    const expandedIn = railLabelMotion(true, false);
    expect(expandedIn.animate).toEqual({ opacity: 1, x: 0 });
    expect(expandedIn.transition).toMatchObject({ duration: 0.15, delay: 0.05 });

    const collapsedOut = railLabelMotion(false, false);
    expect(collapsedOut.animate.opacity).toBe(0);
    expect(collapsedOut.transition).toMatchObject({ delay: 0 });
  });

  test('reduced motion: no slide offset and zero duration', () => {
    const reducedCollapsed = railLabelMotion(false, true);
    expect(reducedCollapsed.animate).toEqual({ opacity: 0, x: 0 });
    expect(reducedCollapsed.transition).toEqual({ duration: 0 });
    expect(railLabelMotion(true, true).transition).toEqual({ duration: 0 });
  });
});
