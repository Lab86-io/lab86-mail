import { describe, expect, test } from 'bun:test';
import {
  BRIEF_ENTITY_SUBTITLE_MAX,
  BRIEF_ENTITY_TITLE_MAX,
  briefEntitySubtitle,
  briefEntityTitle,
  cutAtWord,
} from '../lib/shared/brief-entity-text';
import { BriefHydratedEntitySchema } from '../lib/shared/brief-hydration';

describe('cutAtWord', () => {
  test('leaves short text alone', () => {
    expect(cutAtWord('Quarterly invoice', 500)).toBe('Quarterly invoice');
  });

  test('cuts on the last word boundary inside the limit', () => {
    const text = 'alpha beta gamma delta epsilon';
    const cut = cutAtWord(text, 18);
    expect(cut).toBe('alpha beta gamma');
    expect(cut.length).toBeLessThanOrEqual(18);
  });

  test('cuts at the limit when the only word boundary is early', () => {
    const text = `a ${'b'.repeat(40)}`;
    const cut = cutAtWord(text, 20);
    expect(cut.length).toBe(20);
    expect(cut.startsWith('a b')).toBe(true);
  });

  test('never splits a surrogate pair', () => {
    const text = `${'x'.repeat(9)}😀 and more words here`;
    const cut = cutAtWord(text, 10);
    expect(cut).toBe('xxxxxxxxx');
    expect(() => new TextEncoder().encode(cut)).not.toThrow();
  });

  test('replaces a lone surrogate before the cut', () => {
    expect(cutAtWord('bad \ud83d end', 100)).toBe('bad � end');
  });
});

describe('brief entity fields', () => {
  test('a long subject becomes a title the contract accepts', () => {
    const subject = Array.from({ length: 120 }, (_, index) => `word${index}`).join(' ');
    const title = briefEntityTitle(subject, '(no subject)');
    expect(title.length).toBeLessThanOrEqual(BRIEF_ENTITY_TITLE_MAX);
    expect(title.endsWith('word')).toBe(false);
    expect(() =>
      BriefHydratedEntitySchema.parse({ kind: 'thread', id: 't1', account: 'a1', title }),
    ).not.toThrow();
  });

  test('an empty or non-string title takes the fallback', () => {
    expect(briefEntityTitle('', 'Untitled event')).toBe('Untitled event');
    expect(briefEntityTitle('   ', 'Untitled event')).toBe('Untitled event');
    expect(briefEntityTitle(undefined, 'Untitled task')).toBe('Untitled task');
    expect(briefEntityTitle(42, 'Untitled task')).toBe('Untitled task');
  });

  test('a long description becomes a subtitle the contract accepts', () => {
    const description = `${'lorem ipsum '.repeat(200)}tail`;
    const subtitle = briefEntitySubtitle(description);
    expect(subtitle).toBeDefined();
    expect(subtitle!.length).toBeLessThanOrEqual(BRIEF_ENTITY_SUBTITLE_MAX);
    expect(() =>
      BriefHydratedEntitySchema.parse({ kind: 'card', id: 'c1', title: 'Pay', subtitle }),
    ).not.toThrow();
  });

  test('an empty subtitle is undefined, not an empty string', () => {
    expect(briefEntitySubtitle('')).toBeUndefined();
    expect(briefEntitySubtitle('  ')).toBeUndefined();
    expect(briefEntitySubtitle(null)).toBeUndefined();
    expect(briefEntitySubtitle('Room 4')).toBe('Room 4');
  });
});
