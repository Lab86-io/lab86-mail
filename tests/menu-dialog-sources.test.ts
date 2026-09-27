import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/*
 * A menu item that opens a dialog or a sheet must wait until the menu has
 * closed (`onSelectAfterClose`). Opened from `onSelect`, or nested inside the
 * menu, the dialog and the menu hold the page lock at once, and the body can
 * keep `pointer-events: none` after both close. The DOM behavior is covered by
 * tests/menu-dialog-handoff.test.tsx; this guard keeps new call sites honest.
 */

const ROOT = path.join(import.meta.dir, '..');

function files(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) files(full, out);
    else if (full.endsWith('.tsx')) out.push(full);
  }
  return out;
}

const sources = ['components', 'app'].flatMap((dir) =>
  files(path.join(ROOT, dir)).map((file) => ({
    rel: path.relative(ROOT, file).split(path.sep).join('/'),
    text: readFileSync(file, 'utf8'),
  })),
);

/** Every `<DropdownMenuItem ...>` opening tag with its attributes. */
function menuItemTags(text: string) {
  const tags: string[] = [];
  let from = 0;
  while (true) {
    const start = text.indexOf('<DropdownMenuItem', from);
    if (start < 0) break;
    let depth = 0;
    let end = start;
    for (; end < text.length; end++) {
      const char = text[end];
      if (char === '{') depth++;
      else if (char === '}') depth--;
      else if (char === '>' && depth === 0 && text[end - 1] !== '=') break;
    }
    tags.push(text.slice(start, end + 1));
    from = end + 1;
  }
  return tags;
}

describe('menu items that open a dialog', () => {
  test('no menu item sits inside a dialog or sheet trigger', () => {
    const offenders = sources
      .filter(({ text }) =>
        /<(?:AlertDialog|Dialog|Sheet|Drawer)Trigger\b[^>]*>\s*<DropdownMenu(?:Checkbox|Radio)?Item\b/.test(
          text,
        ),
      )
      .map(({ rel }) => rel);
    expect(offenders).toEqual([]);
  });

  test('no onSelect handler opens a dialog, a sheet, or a confirmation', () => {
    const offenders: string[] = [];
    for (const { rel, text } of sources) {
      for (const tag of menuItemTags(text)) {
        const handler = tag.match(/\bonSelect=\{([\s\S]*?)\}\s*(?:className|disabled|key|>|\/)/)?.[1] ?? '';
        if (/\bset\w*(?:Open|Dialog|Sheet|Confirm\w*|Preview)\(\s*(?:true|[a-z]\w*)\s*\)/.test(handler))
          offenders.push(`${rel}: ${handler.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('each known dialog item waits for the menu to close', () => {
    const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');
    const expectations: Array<[string, string[]]> = [
      [
        'components/inbox/MailNav.tsx',
        ['onSelectAfterClose={() => onList(list.id)}', 'onSelectAfterClose={onSettings}'],
      ],
      ['components/files/FileLocationPicker.tsx', ['onSelectAfterClose={onManage}']],
      ['components/inbox/Inbox.tsx', ['onSelectAfterClose={onApplyLabels}']],
      ['components/thread/ThreadView.tsx', ['onSelectAfterClose={() => setUnsubscribeOpen(true)}']],
      [
        'components/tasks/TasksSurface.tsx',
        ['onSelectAfterClose={onRename}', 'onSelectAfterClose={() => setConfirmDelete(true)}'],
      ],
    ];
    for (const [rel, needles] of expectations) {
      const text = read(rel);
      for (const needle of needles) expect(`${rel}: ${text.includes(needle)}`).toBe(`${rel}: true`);
    }
  });

  test('the guard reads a multi-line menu item tag', () => {
    const tags = menuItemTags(`
      <DropdownMenuItem
        key={list.id}
        onSelect={() => setScheduledOpen(true)}
        className="text-[12.5px]"
      >`);
    expect(tags).toHaveLength(1);
    expect(tags[0]).toContain('setScheduledOpen(true)');
  });
});
