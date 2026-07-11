import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const read = (relativePath: string) => readFileSync(path.join(process.cwd(), relativePath), 'utf8');

describe('Area home query bounds', () => {
  test('uses a selective recency index instead of collecting every filed artifact', () => {
    const schema = read('convex/schema.ts');
    const source = read('convex/albatross.ts');
    const areaHome = source.slice(
      source.indexOf('const AREA_HOME_MAIL_CAP'),
      source.indexOf('const UNCLASSIFIED_SCAN'),
    );

    expect(schema).toContain(".index('by_user_area_kind_status_updatedAt'");
    expect(areaHome).toContain(".withIndex('by_user_area_kind_status_updatedAt'");
    expect(areaHome).toContain('.take(cap + 1)');
    expect(areaHome).toContain('.slice(0, cap + 1)');
    expect(areaHome).not.toContain(
      ".withIndex('by_user_area', (q) => q.eq('userId', userId).eq('areaId', args.areaId))\n        .collect()",
    );
  });

  test('keeps separate caps for high-volume evidence kinds', () => {
    const source = read('convex/albatross.ts');
    const bounds = source.slice(
      source.indexOf('const AREA_HOME_LINK_SCAN_CAPS'),
      source.indexOf('type AreaHomeArtifactKind'),
    );

    for (const kind of ['mailThread', 'calendarEvent', 'task', 'mcpItem', 'intent', 'manual']) {
      expect(bounds).toContain(`${kind}:`);
    }
  });
});
