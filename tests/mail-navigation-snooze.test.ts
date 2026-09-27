import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { MAIL_LISTS, MAILBOXES } from '../lib/mail/navigation';

// Snooze now archives the thread and a cron brings it back (MUT-1). No
// provider label marks snoozed mail, so a label-based Snoozed view is empty.
test('no mailbox or palette shortcut searches the old snooze label', () => {
  expect(MAILBOXES.some((box) => /snooze/i.test(box.query))).toBe(false);
  const palette = readFileSync(path.join(process.cwd(), 'components/palette/CommandPalette.tsx'), 'utf8');
  expect(palette).not.toContain('MailOS/Snoozed');
});

// The Snoozed entry reads the snooze rows instead and opens as a list.
test('the More menu offers Snoozed next to Scheduled and opens the snoozed list', () => {
  expect(MAIL_LISTS.map((list) => [list.id, list.label])).toEqual([
    ['scheduled', 'Scheduled'],
    ['snoozed', 'Snoozed'],
    ['senders', 'Sender cleanup'],
  ]);
  const nav = readFileSync(path.join(process.cwd(), 'components/inbox/MailNav.tsx'), 'utf8');
  expect(nav).toContain('MAIL_LISTS.map');
  expect(nav).toContain("open={openList === 'snoozed'}");
  expect(nav).toMatch(/<SnoozedThreads\b/);
});
