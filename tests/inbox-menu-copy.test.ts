import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const src = readFileSync(path.join(process.cwd(), 'components/inbox/Inbox.tsx'), 'utf8');

test('Move to never offers Needs reply, which is an attention view', () => {
  const menu = src.slice(src.indexOf('Move to...'), src.indexOf('</DropdownMenuSubContent>'));
  expect(menu).toContain("'main'");
  expect(menu).not.toContain("'needs_reply'");
});

test('the bulk bar and row menu use plain text buttons and no star icon', () => {
  expect(src).not.toContain('AI: triage');
  expect(src).not.toMatch(/<RowIcon icon=\{(Archive|Delete|Gauge)Icon\}/);
  expect(src).not.toMatch(/<Star\b/);
  const menu = src.slice(src.indexOf('<DropdownMenuContent align="end" onClick'), src.indexOf('Move to...'));
  expect(menu).not.toMatch(/className="size-3\.5" \/>/);
});
