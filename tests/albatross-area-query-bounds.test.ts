import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const read = (relativePath: string) => readFileSync(path.join(process.cwd(), relativePath), 'utf8');

function between(source: string, startMarker: string, endMarker: string) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('Area home query bounds', () => {
  test('uses a selective recency index instead of collecting every filed artifact', () => {
    const schema = read('convex/schema.ts');
    const source = read('convex/albatross.ts');
    const areaHome = between(source, 'const AREA_HOME_MAIL_CAP', 'const UNCLASSIFIED_SCAN');

    expect(schema).toContain(".index('by_user_area_kind_status_updatedAt'");
    expect(areaHome).toContain(".withIndex('by_user_area_kind_status_updatedAt'");
    expect(areaHome).toContain('.take(cap + 1)');
    expect(areaHome).toContain('.slice(0, cap + 1)');
    const normalized = areaHome.replace(/\s+/g, ' ');
    expect(normalized).not.toContain(
      ".withIndex('by_user_area', (q) => q.eq('userId', userId).eq('areaId', args.areaId)) .collect()",
    );
  });

  test('keeps separate caps for high-volume evidence kinds', () => {
    const source = read('convex/albatross.ts');
    const bounds = between(source, 'const AREA_HOME_LINK_SCAN_CAPS', 'type AreaHomeArtifactKind');

    for (const kind of ['mailThread', 'calendarEvent', 'task', 'mcpItem', 'intent', 'manual']) {
      expect(bounds).toContain(`${kind}:`);
    }
  });

  test('uses explicit sentinel rows for link and board-card overflow', () => {
    const source = read('convex/albatross.ts');
    const areaHome = between(source, 'const AREA_HOME_MAIL_CAP', 'const UNCLASSIFIED_SCAN');
    expect(areaHome).toContain('.take(cap + 1)');
    expect(areaHome).toContain('.take(201)');
    expect(areaHome).toContain('boardCardScan.length > 200');
  });
});
