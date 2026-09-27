import { expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

// A plain `.slice(0, n)` can cut an emoji in half. Convex, APNs, and Swift's
// JSONDecoder reject the lone surrogate that is left, so one bad string stalls
// a whole queue or list (seen live on staging, 2026-09-26). Cut user and
// provider text with truncateText or safeSlice from lib/shared/text.ts.
const TEXT_NAMES =
  'body|textBody|htmlBody|text|snippet|subject|title|summary|reason|rawText|content|detail|note|notes|description|claim|sender|responseBody|message|excerpt|preview|name';
const PLAIN_CUT = new RegExp(`\\b(${TEXT_NAMES})\\??\\.slice\\(0, *[0-9_]+\\)(?!\\.map)`);
const ROOTS = ['lib', 'convex', 'app/api'];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (entry === '_generated' || entry === 'node_modules') return [];
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry) ? [full] : [];
  });
}

test('user and provider text is never cut with a plain slice', () => {
  const offenders: string[] = [];
  for (const root of ROOTS) {
    for (const file of sourceFiles(path.join(process.cwd(), root))) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, index) => {
          if (PLAIN_CUT.test(line)) offenders.push(`${path.relative(process.cwd(), file)}:${index + 1}`);
        });
    }
  }
  expect(offenders).toEqual([]);
});
