import { describe, expect, test } from 'bun:test';
import { compileMailSearch, UNRESOLVED_FOLDER_PARAM } from '../lib/mail/search/compiler';
import { parseMailSearchQuery } from '../lib/mail/search/parser';

describe('compileMailSearch', () => {
  test('returns a local plan without structured params', () => {
    const ast = parseMailSearchQuery('in:inbox from:alerts@example.test');
    const plan = compileMailSearch(ast, { provider: 'google', tier: 'local', limit: 25 });
    expect(plan).toMatchObject({
      tier: 'local',
      provider: 'google',
      queryParams: { limit: 25 },
    });
    expect(plan.dropped).toEqual([]);
  });
  test('maps Gmail folders to system label ids', () => {
    const ast = parseMailSearchQuery('in:sent is:starred has:attachment');
    const plan = compileMailSearch(ast, { provider: 'google', tier: 'structured', limit: 10 });
    expect(plan.queryParams).toMatchObject({
      limit: 10,
      in: 'SENT',
      starred: true,
      has_attachment: true,
    });
  });
  test('defers Microsoft folders to provider-side resolution', () => {
    const ast = parseMailSearchQuery('in:inbox');
    const plan = compileMailSearch(ast, { provider: 'microsoft', tier: 'structured', limit: 10 });
    expect(plan.queryParams[UNRESOLVED_FOLDER_PARAM]).toBe('INBOX');
    expect(plan.queryParams).not.toHaveProperty('in');
  });
  test('drops duplicate structured filters and unsupported clauses', () => {
    const ast = parseMailSearchQuery('from:a@example.test from:b@example.test invoice -in:spam');
    const plan = compileMailSearch(ast, { provider: 'google', tier: 'structured', limit: 10 });
    expect(plan.queryParams.from).toBe('a@example.test');
    expect(plan.dropped.map((item) => item.reason)).toContain('structured search already has a from filter');
    expect(plan.dropped.map((item) => item.reason)).toContain(
      'structured search does not support negation yet',
    );
    expect(plan.dropped.map((item) => item.reason)).toContain(
      'structured search does not support free-text body search yet',
    );
  });
  test('drops Gmail archive folder and unparseable dates', () => {
    const archive = compileMailSearch(parseMailSearchQuery('in:archive'), {
      provider: 'google',
      tier: 'structured',
      limit: 10,
    });
    expect(archive.dropped[0]?.reason).toBe('folder has no Gmail system label equivalent');

    const badDate = compileMailSearch(parseMailSearchQuery('after:not-a-date'), {
      provider: 'google',
      tier: 'structured',
      limit: 10,
    });
    expect(badDate.dropped[0]?.reason).toBe('unparseable date');
  });
});
