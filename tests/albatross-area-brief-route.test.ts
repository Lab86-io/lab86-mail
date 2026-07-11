import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const source = readFileSync(
  path.join(process.cwd(), 'app/api/albatross/area/[areaId]/brief/route.ts'),
  'utf8',
);

describe('Area brief refresh endpoint', () => {
  test('regenerates prose and starts a best-effort evidence reindex', () => {
    expect(source).toContain('generateAreaLivingBrief({');
    expect(source).toContain('albatross.reindexMyAreas');
    expect(source).toContain('evidence reindex failed');
    expect(source).toContain('await reindex;');
  });

  test('is authenticated, rate-limited, and keeps unknown errors client-safe', () => {
    expect(source).toContain('requireCurrentUser()');
    expect(source).toContain("key: 'albatross-area-brief'");
    expect(source).toContain('error instanceof AreaBriefNotFoundError');
    expect(source).toContain("error: 'brief refresh failed'");
    expect(source).not.toContain('error: message');
  });
});
