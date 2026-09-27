import { expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

// A confirm button that deletes, removes, or disconnects uses the danger color,
// so it never looks like the safe main action (the board column delete used the
// green primary style until 2026-09-27).
function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (entry === 'node_modules') return [];
    if (statSync(full).isDirectory()) return tsxFiles(full);
    return entry.endsWith('.tsx') ? [full] : [];
  });
}

test('destructive confirm buttons use the danger color', () => {
  const offenders: string[] = [];
  for (const root of ['components', 'app']) {
    for (const file of tsxFiles(path.join(process.cwd(), root))) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/<AlertDialogAction\b((?:=>|[^>])*)>\s*([^<{]+)/g)) {
        const [, attributes, label] = match;
        if (
          /^(Delete|Remove|Disconnect|Discard|Erase)/i.test(label.trim()) &&
          !attributes.includes('color-danger')
        )
          offenders.push(`${path.relative(process.cwd(), file)}: ${label.trim()}`);
      }
    }
  }
  expect(offenders).toEqual([]);
});
