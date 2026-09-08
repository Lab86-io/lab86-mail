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
    expect(archive.dropped.map((item) => item.reason)).toContain(
      'folder has no Gmail system label equivalent',
    );

    const badDate = compileMailSearch(parseMailSearchQuery('after:not-a-date'), {
      provider: 'google',
      tier: 'structured',
      limit: 10,
    });
    expect(badDate.dropped.map((item) => item.reason)).toContain('unparseable date');
  });

  test('compiles recipient, subject, and inclusive date bounds for supported providers', () => {
    const ast = parseMailSearchQuery(
      'to:team@example.test subject:Railway after:2026-09-01 before:2026-09-08',
    );
    for (const provider of ['google', 'icloud', 'imap'] as const) {
      const plan = compileMailSearch(ast, { provider, limit: 100, pageToken: 'next-page' });
      expect(plan.queryParams).toEqual({
        limit: 80,
        page_token: 'next-page',
        to: 'team@example.test',
        subject: 'Railway',
        latest_message_after: Date.parse('2026-09-01T00:00:00Z') / 1000,
        latest_message_before: Date.parse('2026-09-08T23:59:59Z') / 1000,
      });
      expect(plan.dropped).toEqual([]);
    }
  });

  test('reports unsupported importance and OR filters rather than silently compiling them', () => {
    const plan = compileMailSearch(
      parseMailSearchQuery('is:important from:(a@example.test OR b@example.test)'),
      {
        provider: 'google',
        limit: 10,
      },
    );
    expect(plan.queryParams).toEqual({ limit: 10 });
    expect(plan.dropped.map(({ reason }) => reason)).toEqual([
      'structured search does not expose provider importance',
      'structured search does not support OR groups yet',
    ]);
  });

  test('does not send unsupported date bounds to Microsoft thread listing', () => {
    const plan = compileMailSearch(parseMailSearchQuery('after:2026-09-01 before:2026-09-08'), {
      provider: 'microsoft',
      limit: 10,
    });
    expect(plan.queryParams).toEqual({ limit: 10 });
    expect(plan.dropped).toHaveLength(2);
    expect(plan.dropped.every(({ reason }) => reason.includes('Microsoft thread listing'))).toBe(true);
  });

  test('drops an invalid before date without discarding a valid subject filter', () => {
    const plan = compileMailSearch(parseMailSearchQuery('subject:Railway before:not-a-date'), {
      provider: 'google',
      limit: 10,
    });
    expect(plan.queryParams).toEqual({ limit: 10, subject: 'Railway' });
    expect(plan.dropped.map(({ reason }) => reason)).toEqual(['unparseable date']);
  });
});
