import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// TASTE-1 and TASTE-2 (audit 2026-09-26), native side: the shared Apple
// sources never say "AI" in a string literal and never draw sparkles.
const roots = ['apps/ios/Lab86Mail', 'apps/ios/Shared'];

function swiftFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return swiftFiles(path);
    return path.endsWith('.swift') ? [path] : [];
  });
}

function offenders(pattern: RegExp) {
  const found: string[] = [];
  for (const file of roots.flatMap(swiftFiles)) {
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, index) => {
        if (line.trim().startsWith('//')) return;
        if (pattern.test(line)) found.push(`${file}:${index + 1}`);
      });
  }
  return found;
}

describe('native copy rules', () => {
  test('no string literal says AI', () => {
    expect(offenders(/"[^"\n]*\bAI\b[^"\n]*"/)).toEqual([]);
  });

  test('no sparkles symbols', () => {
    expect(offenders(/sparkles/)).toEqual([]);
  });
});
