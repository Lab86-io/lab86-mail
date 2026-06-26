import { describe, expect, test } from 'bun:test';
import { parseMailSearchQuery } from '../lib/mail/search/parser';

describe('parseMailSearchQuery', () => {
  test('parses folder, unread, and attachment operators', () => {
    const ast = parseMailSearchQuery('in:inbox is:unread has:attachment');
    expect(ast.clauses).toEqual([
      { type: 'folder', value: 'inbox', negated: false },
      { type: 'unread', value: true, negated: false },
      { type: 'attachment', value: true, negated: false },
    ]);
  });
  test('parses address and subject filters', () => {
    const ast = parseMailSearchQuery('from:alerts@example.test subject:magic');
    expect(ast.clauses).toEqual([
      { type: 'from', value: 'alerts@example.test', negated: false },
      { type: 'subject', value: 'magic', negated: false },
    ]);
  });
  test('parses relative date operators into ISO dates', () => {
    const ast = parseMailSearchQuery('newer_than:7d older_than:1w');
    expect(ast.clauses[0]).toMatchObject({ type: 'after', negated: false });
    expect(ast.clauses[1]).toMatchObject({ type: 'before', negated: false });
    expect(String(ast.clauses[0]?.value)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
  test('supports OR groups and negation', () => {
    const ast = parseMailSearchQuery('from:(icloud.com OR me.com) -in:spam');
    expect(ast.clauses[0]).toMatchObject({ type: 'or', negated: false });
    expect(ast.clauses[1]).toMatchObject({ type: 'folder', value: 'spam', negated: true });
  });
  test('preserves free-text tokens and unknown operators', () => {
    const ast = parseMailSearchQuery('invoice custom:foo');
    expect(ast.clauses[0]).toMatchObject({ type: 'text', value: 'invoice' });
    expect(ast.clauses[1]).toMatchObject({ type: 'text', value: 'custom:foo' });
  });
  test('maps is:read and is:starred', () => {
    const ast = parseMailSearchQuery('is:read is:starred is:important');
    expect(ast.clauses).toEqual([
      { type: 'unread', value: false, negated: false },
      { type: 'starred', value: true, negated: false },
      { type: 'important', value: true, negated: false },
    ]);
  });
});
