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
    // The date renders as a plain span; a button here would swallow the
    // hover action strip that overlays this slot.
    expect(inbox).toMatch(/<span[^>]*tabular-nums[^>]*>\s*\{formatDate\(date\)\}/);
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
  test('the verbs sit at the trailing edge, not centered', () => {
    expect(thread).toContain('bottom-4 z-10 flex justify-end');
  });
});

describe('the reader header lines up with the inbox header', () => {
  // An explicit row height on both sides, not padding around whatever each
  // row happens to hold: bordered segment groups are 2px taller than a bare
  // button, which is what made the two rules step apart.
  test('both headers are h-12 rows', () => {
    expect(thread).toContain('flex h-12 shrink-0 items-center gap-3 border-b');
    expect(read('components/inbox/MailNav.tsx')).toContain(
      'flex h-12 shrink-0 items-center gap-1.5 border-b',
    );
  });
  test('the title rides in the strip', () => {
    expect(thread).toContain('truncate font-display text-[15px]');
  });
  test('no stale reserve pushes the view actions off the right edge', () => {
    expect(thread).not.toContain('pr-12');
  });
});

describe('the reader stands in one of two places', () => {
  // Mail is a card the reader can halve. Today and Areas are not, so the
  // thread visits them as a sheet over the page.
  test('the variant drives the shell, not the surface', () => {
    expect(thread).toContain("variant === 'sheet'");
    expect(thread).toContain('shadow-[var(--shadow-pop)]');
  });
  test('only Mail splits; every other surface gets the sheet', () => {
    expect(shell).toContain("readerSplit = readerVisible && visiblePrimaryView === 'mail'");
    expect(shell).toContain('readerSheet = readerVisible && !readerSplit');
    expect(shell).toContain('<ThreadView variant="sheet" />');
    // The split panel and separator must follow readerSplit, not readerVisible,
    // or a sheet surface would still tear its layout in half.
    expect(shell).not.toContain('{readerVisible ? <ResizeSeparator');
  });
});
