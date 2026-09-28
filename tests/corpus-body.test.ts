import { describe, expect, test } from 'bun:test';
import {
  ABSENT_BODY_PART,
  bodyExcerpt,
  bodyHashHasBody,
  bodyPartHash,
  buildSmallSearchText,
  CORPUS_HTML_BODY_MAX_CHARS,
  CORPUS_SEARCH_HEADER_MAX_CHARS,
  CORPUS_TEXT_BODY_MAX_CHARS,
  capHtmlBody,
  capTextBody,
  isLegacyCorpusMessage,
  joinBodyHash,
  splitBodyHash,
  storedBodyExcerpt,
  storedBodyText,
} from '../lib/mail/corpus-body';
import { clipClassifierBody } from '../lib/mail/smart-categories';

describe('body hashes', () => {
  test('a part hash changes with the content and marks an absent part', () => {
    expect(bodyPartHash(undefined)).toBe(ABSENT_BODY_PART);
    expect(bodyPartHash(null)).toBe(ABSENT_BODY_PART);
    expect(bodyPartHash('')).not.toBe(ABSENT_BODY_PART);
    expect(bodyPartHash('hello')).toBe(bodyPartHash('hello'));
    expect(bodyPartHash('hello')).not.toBe(bodyPartHash('hellp'));
    expect(bodyPartHash('a'.repeat(10))).not.toBe(bodyPartHash('a'.repeat(11)));
  });

  test('the joined hash splits back into its parts', () => {
    const joined = joinBodyHash({ text: bodyPartHash('text'), html: ABSENT_BODY_PART });
    expect(splitBodyHash(joined)).toEqual({ text: bodyPartHash('text'), html: ABSENT_BODY_PART });
    expect(splitBodyHash(undefined)).toEqual({ text: ABSENT_BODY_PART, html: ABSENT_BODY_PART });
    expect(bodyHashHasBody(joined)).toBe(true);
    expect(bodyHashHasBody(joinBodyHash({ text: ABSENT_BODY_PART, html: ABSENT_BODY_PART }))).toBe(false);
    expect(bodyHashHasBody(joinBodyHash({ text: ABSENT_BODY_PART, html: bodyPartHash('') }))).toBe(true);
  });

  test('the caps keep the old limits and never split a surrogate pair', () => {
    expect(capTextBody('x'.repeat(CORPUS_TEXT_BODY_MAX_CHARS + 10))).toHaveLength(CORPUS_TEXT_BODY_MAX_CHARS);
    expect(capHtmlBody('<p>'.repeat(CORPUS_HTML_BODY_MAX_CHARS))).toHaveLength(CORPUS_HTML_BODY_MAX_CHARS);
    const emoji = `${'a'.repeat(CORPUS_TEXT_BODY_MAX_CHARS - 1)}😀`;
    expect(capTextBody(emoji).endsWith('\uD83D')).toBe(false);
    expect(capTextBody(undefined)).toBe('');
  });
});

describe('small search text', () => {
  test('holds the header line, then the body excerpt with its line breaks', () => {
    const body = `Hello\n> quoted line\n${'x'.repeat(6000)}\nUnsubscribe here`;
    const excerpt = bodyExcerpt(body);
    expect(excerpt).toBe(clipClassifierBody(body));
    expect(excerpt).toContain('\n> quoted line');
    expect(excerpt).toContain('Unsubscribe here');
    // Jev reads the first 2,400 characters; they are the same as in the full body.
    expect(excerpt.slice(0, 2400)).toBe(body.slice(0, 2400));
    const { searchText, excerptAt } = buildSmallSearchText(
      {
        subject: 'Budget',
        from: 'maya@example.test',
        to: 'me@example.test',
        snippet: 'Hi',
        labels: ['INBOX'],
      },
      excerpt,
    );
    expect(searchText.slice(0, excerptAt - 1)).toBe('Budget maya@example.test me@example.test Hi INBOX');
    expect(searchText.slice(excerptAt)).toBe(excerpt);
    expect(searchText.length).toBeLessThan(CORPUS_SEARCH_HEADER_MAX_CHARS + 4100);
  });

  test('caps a long header and works with no body', () => {
    const many = Array.from({ length: 400 }, (_, index) => `person${index}@example.test`).join(', ');
    const { searchText, excerptAt } = buildSmallSearchText({ subject: 'List', to: many }, '');
    expect(searchText).toHaveLength(CORPUS_SEARCH_HEADER_MAX_CHARS);
    expect(excerptAt).toBe(searchText.length);
  });
});

describe('stored body text', () => {
  test('a document from before the split gives its inline text', () => {
    const legacy = { textBody: 'Full inline text', searchText: 'old search text' };
    expect(isLegacyCorpusMessage(legacy)).toBe(true);
    expect(storedBodyText(legacy)).toBe('Full inline text');
    expect(storedBodyExcerpt(legacy, 4)).toBe('Full');
    expect(isLegacyCorpusMessage({ searchText: 'no hash' })).toBe(true);
    expect(storedBodyText({ searchText: 'no hash' })).toBe('');
  });

  test('a split document gives the excerpt that starts at excerptAt', () => {
    const { searchText, excerptAt } = buildSmallSearchText({ subject: 'S' }, 'Body text');
    const split = { searchText, excerptAt, bodyHash: joinBodyHash({ text: 'a', html: 'b' }) };
    expect(isLegacyCorpusMessage(split)).toBe(false);
    expect(storedBodyText(split)).toBe('Body text');
    expect(storedBodyText({ ...split, excerptAt: 999 })).toBe('');
    expect(storedBodyText(null)).toBe('');
    expect(isLegacyCorpusMessage(null)).toBe(false);
  });
});
