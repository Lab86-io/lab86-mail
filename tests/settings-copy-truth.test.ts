import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { SETTINGS_TABS } from '../lib/albatross/teach-ui';

const source = (rel: string) => readFileSync(path.join(process.cwd(), rel), 'utf8');

test('the support page names settings tabs that exist and the current product name', () => {
  const support = source('app/support/page.tsx');
  expect(support).not.toContain('Accounts and AI');
  expect(support).not.toContain('Lab86 Mail');
  const labels = SETTINGS_TABS.map((tab) => tab.label);
  expect(labels).toContain('Account');
  expect(support).toContain('open Settings, Account, and choose Delete account');
  expect(source('app/settings/page.tsx')).toContain('Delete account');
});

test('settings copy does not promise behavior the product does not have', () => {
  const settings = source('app/settings/page.tsx');
  // Unanswered check-ins are not carried into the Brief (UI-25).
  expect(settings).not.toContain('carry an unanswered check-in');
  // Scheduled sends do not use the undo hold (UI-9).
  expect(settings).not.toContain('Scheduled sends and replies from the brief use the same hold');
});
