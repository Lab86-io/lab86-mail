import { expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

// Product rule: user copy never says "AI". Use Intelligence, draft, sort, or
// models. Legal pages need their own decision, API routes are not UI, and
// components/narrative is owned by the narrative pass.
const ROOTS = ['components', 'app'];
const SKIP = ['app/api/', 'app/privacy/', 'components/narrative/'];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return files(full);
    return full.endsWith('.tsx') ? [full] : [];
  });
}

/** Lines of text a user can read: string literals and JSX text, not comments. */
export function userCopyHits(source: string): string[] {
  const noComments = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  const hits: string[] = [];
  const pattern = /(['"`>])([^'"`<>{}\n]*\bAI\b[^'"`<>{}\n]*)(?=['"`<{])/g;
  for (const match of noComments.matchAll(pattern)) {
    const text = match[2];
    if (/\bOpenAI\b/.test(text) && !/(^|[^n])\bAI\b/.test(text.replace(/OpenAI/g, ''))) continue;
    hits.push(text.trim());
  }
  return hits;
}

test('the scanner finds AI in strings and JSX text, not in names or comments', () => {
  expect(userCopyHits(`const a = 'Save AI settings';`)).toEqual(['Save AI settings']);
  expect(userCopyHits('<p>AI draft</p>')).toEqual(['AI draft']);
  expect(userCopyHits('// AI comment\nconst AIBar = 1; <p>OpenAI</p>')).toEqual([]);
});

test('web user copy never says AI', () => {
  const offenders: string[] = [];
  for (const root of ROOTS) {
    for (const file of files(path.join(process.cwd(), root))) {
      const rel = path.relative(process.cwd(), file).split(path.sep).join('/');
      if (SKIP.some((prefix) => rel.startsWith(prefix))) continue;
      for (const hit of userCopyHits(readFileSync(file, 'utf8'))) offenders.push(`${rel}: ${hit}`);
    }
  }
  expect(offenders).toEqual([]);
});
