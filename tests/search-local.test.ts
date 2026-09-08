import { describe, expect, test } from 'bun:test';
import {
  type CorpusMessageDocument,
  compileAstToLocalCorpusQuery,
  filterCorpusMessagesByAst,
} from '../lib/mail/search/local';
import { parseMailSearchQuery } from '../lib/mail/search/parser';

const message: CorpusMessageDocument = {
  accountId: 'account',
  provider: 'google',
  providerMessageId: 'message',
  providerThreadId: 'thread',
  subject: 'Railway deployment',
  from: 'alerts@railway.app',
  to: 'team@example.test',
  cc: 'reviewer@example.test',
  bcc: 'archive@example.test',
  receivedAt: Date.parse('2026-09-08T12:00:00Z'),
  snippet: 'Deployment ready',
  searchText: 'Railway deployment ready',
  labels: ['INBOX', 'IMPORTANT', 'STARRED'],
  attachments: [{}],
};

describe('typed search against the local mail corpus', () => {
  test('matches subject, recipients, flags, attachments, and date bounds together', () => {
    const ast = parseMailSearchQuery(
      'subject:railway to:reviewer@example.test is:important is:starred has:attachment after:2026-09-01 before:2026-09-08',
    );
    expect(filterCorpusMessagesByAst([message], ast)).toEqual([message]);
    expect(filterCorpusMessagesByAst([{ ...message, attachments: [] }], ast)).toEqual([]);
    expect(filterCorpusMessagesByAst([{ ...message, labels: ['INBOX'] }], ast)).toEqual([]);
    expect(filterCorpusMessagesByAst([message], parseMailSearchQuery('to:archive@example.test'))).toEqual([
      message,
    ]);
    expect(filterCorpusMessagesByAst([message], parseMailSearchQuery('subject:unrelated'))).toEqual([]);
  });

  test('keeps OR alternatives out of an all-terms prefilter and evaluates them locally', () => {
    const ast = parseMailSearchQuery('from:(alerts@railway.app OR other@example.test) -subject:failed');
    expect(compileAstToLocalCorpusQuery(ast)).toMatchObject({ query: '', dropped: [] });
    expect(filterCorpusMessagesByAst([message], ast)).toEqual([message]);
    expect(filterCorpusMessagesByAst([{ ...message, subject: 'Failed deployment' }], ast)).toEqual([]);
    expect(filterCorpusMessagesByAst([{ ...message, from: 'unrelated@example.test' }], ast)).toEqual([]);
  });

  test('all mail excludes spam and trash while an explicit folder can retrieve them', () => {
    const spam = { ...message, labels: ['SPAM'] };
    const trash = { ...message, labels: ['TRASH'] };
    const messages = [message, spam, trash];
    expect(filterCorpusMessagesByAst(messages, parseMailSearchQuery('in:all'))).toEqual([message]);
    expect(filterCorpusMessagesByAst(messages, parseMailSearchQuery('in:spam'))).toEqual([spam]);
    expect(filterCorpusMessagesByAst(messages, parseMailSearchQuery('in:trash'))).toEqual([trash]);
  });
});
