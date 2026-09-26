import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Product rule: no icon before button text. An icon may stand alone (with a
// label for assistive tech), or the text may stand alone.
const BUTTONS: Record<string, string[]> = {
  'components/thread/ThreadView.tsx': ['Show emails with them', 'New email', 'Download', 'Open'],
  'components/thread/InlineComposer.tsx': ['Attach', 'Open'],
  'components/inbox/Inbox.tsx': [
    'Select visible',
    'Archive',
    'Trash',
    'Apply smart labels',
    'Never Main',
    'Always Noise',
    'Move to...',
  ],
  'components/settings/AiSection.tsx': ['Upgrade', 'Save'],
  'app/settings/page.tsx': ['Back to Albatross', 'Resync', 'Disconnect', 'Connect'],
  'components/tasks/TasksSurface.tsx': ['Add card', 'Add column'],
  'components/files/FilesSurface.tsx': [
    'Choose folder',
    'Upload to Albatross',
    'Connect a drive',
    'Setup needed',
  ],
};

/** A self-closing icon element followed directly by words. */
export function leadingIconHits(source: string): string[] {
  const pattern =
    /<(?:RowIcon\b[^>]*|[A-Z][A-Za-z0-9]*\s+className="[^"]*size-[^"]*"[^>]*)\/>\s*(?:\{[^}]*\}\s*)?([A-Z][a-z][^<{\n]*)/g;
  return [...source.matchAll(pattern)].map((match) => match[1].trim());
}

test('the detector finds an icon before text and allows icon-only buttons', () => {
  expect(leadingIconHits('<button><Plus className="size-3" /> Add card</button>')).toEqual(['Add card']);
  expect(leadingIconHits('<button><RowIcon icon={X} size={12} />\n  Archive\n</button>')).toEqual([
    'Archive',
  ]);
  expect(
    leadingIconHits('<button><Trash2 className="size-3.5" />\n<span className="sr-only">Delete</span>'),
  ).toEqual([]);
});

test('reader, composer, inbox, settings, tasks, and files buttons have no leading icons', () => {
  const offenders = Object.entries(BUTTONS).flatMap(([file, texts]) =>
    leadingIconHits(readFileSync(path.join(process.cwd(), file), 'utf8'))
      .filter((hit) => texts.includes(hit))
      .map((hit) => `${file}: ${hit}`),
  );
  expect(offenders).toEqual([]);
});

test('the calendar Today button does not use an all-caps month label', () => {
  const button = readFileSync(
    path.join(process.cwd(), 'components/calendar/engine/today-button.tsx'),
    'utf8',
  );
  expect(button).not.toContain('uppercase');
});
