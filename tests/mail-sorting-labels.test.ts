import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { SETTINGS_TABS } from '../lib/albatross/teach-ui';
import { mailSortingLine } from '../lib/shell/mail-sorting-labels';

test('the reader names the purpose in plain words, not internal values', () => {
  expect(mailSortingLine({ purpose: 'transaction', status: 'classified' })).toBe(
    'Classification · Receipt · Classified',
  );
  expect(mailSortingLine({ purpose: 'conversation', status: 'uncertain' }, 'Jev 1.13')).toBe(
    'Jev 1.13 · Conversation · More context may be needed',
  );
  expect(mailSortingLine({ purpose: 'something-new' })).toBe('Classification · Unclear · Classified');
});

test('the settings tab uses the Classification name and the reader shows no raw purpose', () => {
  expect(SETTINGS_TABS.find((tab) => tab.id === 'jev')?.label).toBe('Classification');
  const reader = readFileSync(path.join(process.cwd(), 'components/thread/JevMailDetails.tsx'), 'utf8');
  expect(reader).toContain('mailSortingLine(');
  expect(reader).not.toMatch(/\{assessment\.purpose\}/);
});
