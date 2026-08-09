import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(import.meta.dir, '..', p), 'utf8');
const thread = read('components/thread/ThreadView.tsx');
const inbox = read('components/inbox/Inbox.tsx');
const shell = read('components/shell/AppShell.tsx');

// The mail surface is ONE elevated card: list half, seam, reader half. These
// pin the seam classes so a styling pass cannot quietly split it back into
// two cards.
describe('one mail surface', () => {
  test('the reader is the right half of the card, not a second card', () => {
    expect(thread).toContain('sm:rounded-r-xl');
    expect(thread).toContain('sm:border-l-0');
    expect(inbox).toContain('sm:rounded-r-none');
    expect(inbox).toContain('sm:border-r-0');
    expect(shell).toContain('inset-y-2 border-y');
  });
  test('the reader interior is flat — no nested surface rungs', () => {
    expect(thread).not.toContain('surface-float');
  });
  test('the date carries no interaction, so hover actions may cover it', () => {
    expect(inbox).toContain('the date must carry no interaction');
    expect(inbox).toContain('Mailbox this thread arrived in');
  });
});

describe('the reader verbs', () => {
  test('the recognition is a declaration, not a hand-off', () => {
    expect(thread).toContain('This is an Albatross');
    expect(thread).not.toContain('Hand to Albatross');
  });
  test('the composer replaces the floating bar while open', () => {
    expect(thread).toContain('composeForThisThread ? null');
  });
  test('the title lives in the scroll and never truncates', () => {
    expect(thread).not.toContain('truncate font-display text-[17px]');
    expect(thread).toContain('text-pretty font-display');
  });
});
