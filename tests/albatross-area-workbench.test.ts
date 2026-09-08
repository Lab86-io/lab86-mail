import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (relativePath: string) => readFileSync(join(import.meta.dir, '..', relativePath), 'utf8');

describe('the Area detail workbench', () => {
  test('keeps Brief left and Area Inbox right without a primary tab rail', () => {
    const source = read('components/albatross/AreaHome.tsx');
    expect(source).toContain('data-area-workbench');
    expect(source.indexOf('data-area-brief-column')).toBeLessThan(source.indexOf('data-area-inbox-column'));
    expect(source).toContain('min-[1100px]:grid-cols-[minmax(0,1.15fr)_minmax(380px,0.85fr)]');
    expect(source).toContain('<AreaInbox home={home} />');
    expect(source).not.toContain('role="tablist"');
    expect(source).not.toContain("areaView === 'inbox'");
  });

  test('preserves a secondary route to Area Albatrosses', () => {
    const source = read('components/albatross/AreaHome.tsx');
    expect(source).toContain("setAreaView('albatrosses')");
    expect(source).toContain('Back to brief &amp; inbox');
  });
});

describe('Today is the Brief', () => {
  test('mounts the full report without the dashboard wrapper', () => {
    const today = read('components/report/Today.tsx');
    expect(today).toContain('return <DailyReport />');
    expect(today).not.toContain('TodaySurface');
    expect(today).not.toContain('embedded');
  });
});
