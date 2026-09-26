import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

// A production build must not need the network for fonts: next/font/google
// fetches at build time, and that fetch failed twice on 2026-09-26.
test('the app layout loads its fonts from files in the repo', () => {
  const layout = readFileSync(path.join(process.cwd(), 'app/layout.tsx'), 'utf8');
  expect(layout).not.toContain('next/font/google');
  const paths = [...layout.matchAll(/path: '(\.\/fonts\/[^']+)'/g)].map((match) => match[1]);
  expect(paths.length).toBeGreaterThan(0);
  for (const file of paths) expect(existsSync(path.join(process.cwd(), 'app', file))).toBe(true);
});
