import { expect, test } from 'bun:test';
import { applyDraftReply } from '../lib/shell/draft-reply';

test('a model draft fills an empty composer with no notice', () => {
  expect(applyDraftReply('  ', { draft: 'Friday works.', model: 'fast' })).toEqual({
    body: 'Friday works.',
    notice: null,
  });
});

test('a draft never replaces typed text, and says so', () => {
  expect(applyDraftReply('My own words', { draft: 'Friday works.', model: 'fast' })).toEqual({
    body: 'My own words',
    notice: {
      kind: 'info',
      text: 'Your message already has text, so the draft was not added. Clear it and try again.',
    },
  });
});

test('a starter template with no model is named as one', () => {
  const next = applyDraftReply('', { draft: 'Hi Alex,\n\nThanks for reaching out.', model: 'local' });
  expect(next.body).toContain('Thanks for reaching out.');
  expect(next.notice?.text).toContain('No model is set up');
});

test('an empty draft is an error', () => {
  expect(applyDraftReply('', { draft: '', model: 'none' }).notice).toEqual({
    kind: 'error',
    text: 'Could not draft a reply.',
  });
});
