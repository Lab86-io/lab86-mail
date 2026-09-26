import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const source = (rel: string) => readFileSync(path.join(process.cwd(), rel), 'utf8');

// The "Rail wash" slider wrote --wash-opacity after the stylesheet stopped
// reading it, so the control did nothing. Every variable the theme panel
// writes must be read by the stylesheet.
test('every theme variable the panel writes has a CSS reader', () => {
  const panel = source('components/shell/ThemePanel.tsx');
  const css = source('app/globals.css');
  const written = [...panel.matchAll(/setOrClear\('(--[a-z0-9-]+)'/g)].map((m) => m[1]);
  expect(written.length).toBeGreaterThan(3);
  for (const name of written)
    expect({ name, read: css.includes(`var(${name}`) }).toEqual({ name, read: true });
  expect(panel).not.toContain('Rail wash');
});
