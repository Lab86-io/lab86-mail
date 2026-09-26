import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// TASTE-1 and TASTE-2 (audit 2026-09-26), native side: the shared Apple
// sources and the Mac shell never say "AI" in a string literal and never draw
// sparkles.
const macRoots = ['apps/ios/Lab86MailMac'];
const roots = ['apps/ios/Lab86Mail', 'apps/ios/Shared', ...macRoots];

function swiftFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return swiftFiles(path);
    return path.endsWith('.swift') ? [path] : [];
  });
}

function offenders(pattern: RegExp, scanned: string[] = roots) {
  const found: string[] = [];
  for (const file of scanned.flatMap(swiftFiles)) {
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

  // Shared mail keeps its star for starred threads. The Mac shell has no
  // starred state of its own, so a star there is decoration.
  test('the Mac shell draws no star symbols', () => {
    expect(offenders(/"star[."]/, macRoots)).toEqual([]);
  });
});
