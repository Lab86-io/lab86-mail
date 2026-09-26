import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { MAILBOXES } from '../lib/mail/navigation';

// Snooze now archives the thread and a cron brings it back (MUT-1). No
// provider label marks snoozed mail, so a label-based Snoozed view is empty.
test('no mailbox or palette shortcut searches the old snooze label', () => {
  expect(MAILBOXES.some((box) => /snooze/i.test(box.query))).toBe(false);
  const palette = readFileSync(path.join(process.cwd(), 'components/palette/CommandPalette.tsx'), 'utf8');
  expect(palette).not.toContain('MailOS/Snoozed');
});
