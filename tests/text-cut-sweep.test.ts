import { describe, expect, test } from 'bun:test';
import { chatCaptureRawText } from '../lib/albatross/capture-from-chat';
import { captureFallbackItem, preserveCaptureText } from '../lib/albatross/work-v2';
import { briefNotificationBody } from '../lib/mail/brief-ready';
import { matchingMailExcerpt } from '../lib/mail/search/ranking';
import { clipClassifierBody } from '../lib/mail/smart-categories';
import { normalizeRecommendation } from '../lib/mail/thread-handoff';
import { cleanNarrativeProse, NARRATIVE_LIMITS } from '../lib/narrative/core';

// An emoji is two UTF-16 code units. Each input below puts one across the
// cut, so a plain `.slice` would leave a lone surrogate that Convex rejects.
const EMOJI = '\u{1F600}';
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const across = (index: number, tail = 'tail') => `${'x'.repeat(index - 1)}${EMOJI}${tail}`;

function expectWellFormed(value: string | undefined) {
  expect(typeof value).toBe('string');
  expect(LONE.test(value!)).toBe(false);
  expect(JSON.stringify(value)).not.toMatch(/\\ud[89a-f][0-9a-f]{2}/i);
}

describe('text cuts keep emoji whole at their limits', () => {
  test('mail classifier, search excerpt, handoff and notification cuts', () => {
    // Head cut at 2500, tail cut at -1500.
    const body = `${across(2500)}${'y'.repeat(3000)}${EMOJI}${'z'.repeat(1499)}`;
    expect(LONE.test(body.slice(0, 2500))).toBe(true);
    expect(LONE.test(body.slice(-1500))).toBe(true);
    expectWellFormed(clipClassifierBody(body));
    expect(clipClassifierBody('short body')).toBe('short body');

    const excerptSource = `${'a'.repeat(10)}${EMOJI}${'b'.repeat(119)}budget`;
    expect(LONE.test(excerptSource.slice(excerptSource.indexOf('budget') - 120))).toBe(true);
    expectWellFormed(matchingMailExcerpt(excerptSource, 'budget'));
    expectWellFormed(matchingMailExcerpt(across(1600), 'none'));

    expectWellFormed(normalizeRecommendation(across(280, ' and more words')));
    expect(normalizeRecommendation('Reply to Maya with the signed budget today')).toBe(
      'Reply to Maya with the signed budget today',
    );

    const lede = across(180, ' more words to pass the limit');
    expectWellFormed(briefNotificationBody({ prose: { lede } }));
    expectWellFormed(
      briefNotificationBody({ prose: { lede: across(179, ' more words to pass the limit') } }),
    );
  });

  test('capture, work and narrative cuts', () => {
    expectWellFormed(chatCaptureRawText(across(20_000)));
    expect(chatCaptureRawText(' hello ', ' reply ')).toBe('hello\n\nreply');
    expectWellFormed(preserveCaptureText(across(20_000)));
    expectWellFormed(captureFallbackItem(across(180)).title);
    expect(captureFallbackItem('Book the dentist').title).toBe('Book the dentist');
    expectWellFormed(cleanNarrativeProse(across(NARRATIVE_LIMITS.body)));
    expect(cleanNarrativeProse('<b>Met</b>   Maya')).toBe('Met Maya');
  });
});
