import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(import.meta.dir, '../components/inbox/Inbox.tsx'), 'utf8');

// The action strip is CSS-revealed, so the contract lives in the class list:
// these assertions pin the reveal paths and the no-reserved-gutter layout.
describe('inbox row action strip', () => {
  test('reveals on hover, keyboard focus, and open menus', () => {
    expect(src).toContain('group-hover:pointer-events-auto group-hover:opacity-100');
    expect(src).toContain('group-focus-within:pointer-events-auto group-focus-within:opacity-100');
    expect(src).toContain('has-[[data-state=open]]:pointer-events-auto');
  });

  test('floats over the date instead of reserving a gutter', () => {
    expect(src).toContain('absolute inset-y-0 right-0');
    expect(src).not.toContain('w-[112px]');
  });

  test('stays revealed while a row is selected', () => {
    expect(src).toContain("selected && 'pointer-events-auto opacity-100'");
  });
});
