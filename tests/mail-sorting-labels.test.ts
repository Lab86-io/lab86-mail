import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { SETTINGS_TABS } from '../lib/albatross/teach-ui';
import { mailSortingLine } from '../lib/shell/mail-sorting-labels';

test('the reader names the sort in plain words, not internal values', () => {
  expect(mailSortingLine({ purpose: 'transaction', status: 'classified' })).toBe(
    'Mail sorting · Receipt · Sorted',
  );
  expect(mailSortingLine({ purpose: 'conversation', status: 'uncertain' })).toBe(
    'Mail sorting · Conversation · More context may be needed',
  );
  expect(mailSortingLine({ purpose: 'something-new' })).toBe('Mail sorting · Unclear · Sorted');
});

test('no settings tab or reader string shows the internal classifier name', () => {
  expect(SETTINGS_TABS.find((tab) => tab.id === 'jev')?.label).toBe('Mail sorting');
  const reader = readFileSync(path.join(process.cwd(), 'components/thread/JevMailDetails.tsx'), 'utf8');
  expect(reader).not.toMatch(/>\s*Jev\b|Jev ·|Jev settings/);
});
